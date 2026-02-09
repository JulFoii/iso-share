#!/usr/bin/env bash
set -euo pipefail

# Fully automated deploy helper (intended to be executed on the server).
#
# What it does:
# - pulls the requested image tag
# - recreates the container (controlled replace)
# - waits for HEALTHCHECK=healthy
# - rolls back to the previous image if the new one doesn't become healthy
#
# Usage (on server):
#   ISO_SHARE_IMAGE=ghcr.io/<owner>/<repo>:<tag> ./scripts/server-deploy.sh
#   # or without ISO_SHARE_IMAGE -> defaults to :latest

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="docker-compose.prod.yml"
SERVICE_NAME="iso-share"
CONTAINER_NAME="iso-share-app"
STATE_DIR="${STATE_DIR:-$ROOT_DIR/.deploy}"
mkdir -p "$STATE_DIR"

DEFAULT_IMAGE="ghcr.io/${GITHUB_REPOSITORY:-owner/repo}:latest"
NEW_IMAGE="${ISO_SHARE_IMAGE:-$DEFAULT_IMAGE}"

PREV_IMAGE_FILE="$STATE_DIR/previous_image.txt"
CURRENT_IMAGE_FILE="$STATE_DIR/current_image.txt"

log() { echo "[$(date -Is)] $*"; }

get_running_image() {
  if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    docker inspect -f '{{.Config.Image}}' "$CONTAINER_NAME" 2>/dev/null || true
  fi
}

wait_for_healthy() {
  local timeout_s="${1:-120}"
  local start
  start=$(date +%s)
  while true; do
    if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
      return 1
    fi

    local status
    status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$CONTAINER_NAME" 2>/dev/null || echo "unknown")

    case "$status" in
      healthy) return 0 ;;
      no-healthcheck) return 0 ;; # treat as success if no healthcheck is defined
      unhealthy) return 1 ;;
    esac

    local now
    now=$(date +%s)
    if (( now - start > timeout_s )); then
      return 1
    fi
    sleep 2
  done
}

rollback() {
  local prev_image
  prev_image=$(cat "$PREV_IMAGE_FILE" 2>/dev/null || true)
  if [[ -z "$prev_image" ]]; then
    log "❌ Rollback not possible (no previous image recorded)."
    return 1
  fi
  log "↩️  Rolling back to $prev_image"
  export ISO_SHARE_IMAGE="$prev_image"
  docker compose -f "$COMPOSE_FILE" pull
  docker compose -f "$COMPOSE_FILE" up -d --remove-orphans --force-recreate
  if wait_for_healthy "120"; then
    log "✅ Rollback successful."
    echo "$prev_image" > "$CURRENT_IMAGE_FILE"
    return 0
  fi
  log "❌ Rollback failed; container is not healthy."
  return 1
}

main() {
  log "🚀 Deploy requested: $NEW_IMAGE"

  local running_image
  running_image=$(get_running_image)
  if [[ -n "$running_image" ]]; then
    echo "$running_image" > "$PREV_IMAGE_FILE"
    log "ℹ️  Previous running image: $running_image"
  elif [[ -f "$CURRENT_IMAGE_FILE" ]]; then
    # In case the container isn't running but we deployed before
    cp -f "$CURRENT_IMAGE_FILE" "$PREV_IMAGE_FILE" || true
    log "ℹ️  Previous image loaded from state: $(cat "$PREV_IMAGE_FILE" || true)"
  fi

  export ISO_SHARE_IMAGE="$NEW_IMAGE"
  log "⬇️  Pulling image"
  docker compose -f "$COMPOSE_FILE" pull

  log "🔁 Recreating container"
  docker compose -f "$COMPOSE_FILE" up -d --remove-orphans --force-recreate

  log "🩺 Waiting for healthcheck"
  if wait_for_healthy "180"; then
    log "✅ Deploy successful: $NEW_IMAGE"
    echo "$NEW_IMAGE" > "$CURRENT_IMAGE_FILE"
    docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi

  log "❌ New container did not become healthy."
  rollback
}

main "$@"
