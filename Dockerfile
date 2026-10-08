# >=22.5 fuer node:sqlite (siehe lib/db.js) — v24 ausgeliefert, damit die
# eingebaute SQLite-API ohne --experimental-sqlite-Flag und ohne
# ExperimentalWarning laeuft (auf v22/23 noch flag- bzw. warnungspflichtig).
# Auf Major.Minor gepinnt, damit ein Rebuild reproduzierbar dasselbe Image
# liefert; Dependabot (.github/dependabot.yml) schlaegt Updates als PR vor.
FROM node:24.18-alpine

WORKDIR /app

# Erst nur die Paketdateien, damit der npm-ci-Layer bei reinen Code-
# Aenderungen aus dem Cache kommt
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Anwendungscode — was NICHT ins Image darf (data/, uploads/, .env, ...)
# regelt .dockerignore
COPY . .

# data/ haelt die SQLite-Datenbank, uploads/ die ISOs — beides wird als
# Volume eingehaengt (siehe docker-compose.yml), die Verzeichnisse hier
# existieren nur, damit sie dem node-User gehoeren
RUN mkdir -p uploads tmp-uploads data && \
    chown -R node:node uploads tmp-uploads data

USER node

ENV NODE_ENV=production
EXPOSE 3000

# /healthz statt / — der Healthcheck soll nicht alle 30 s die
# komplette Dateiliste samt Metadaten rendern
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
