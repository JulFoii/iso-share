#!/bin/bash
set -e

# Deployment script for ISO Share
# Usage: ./scripts/deploy.sh [environment] [version]

ENVIRONMENT=${1:-staging}
VERSION=${2:-latest}

echo "🚀 Deploying ISO Share to $ENVIRONMENT environment (version: $VERSION)"

# Load environment variables
if [ -f ".env.$ENVIRONMENT" ]; then
    export $(cat .env.$ENVIRONMENT | xargs)
fi

case $ENVIRONMENT in
    "staging")
        echo "📦 Deploying to staging..."
        docker-compose -f docker-compose.yml up -d
        ;;
    "production")
        echo "📦 Deploying to production..."
        export VERSION=$VERSION
        docker-compose -f docker-compose.prod.yml up -d
        ;;
    "k8s")
        echo "☸️  Deploying to Kubernetes..."
        kubectl apply -f k8s/
        kubectl set image deployment/iso-share iso-share=iso-share:$VERSION
        kubectl rollout status deployment/iso-share
        ;;
    *)
        echo "❌ Unknown environment: $ENVIRONMENT"
        echo "Available environments: staging, production, k8s"
        exit 1
        ;;
esac

# Wait for deployment to be ready
echo "⏳ Waiting for deployment to be ready..."
sleep 10

# Health check
echo "🏥 Running health check..."
case $ENVIRONMENT in
    "staging"|"production")
        if curl -f http://localhost:3000/ > /dev/null 2>&1; then
            echo "✅ Health check passed!"
        else
            echo "❌ Health check failed!"
            exit 1
        fi
        ;;
    "k8s")
        kubectl get pods -l app=iso-share
        ;;
esac

echo "🎉 Deployment completed successfully!"