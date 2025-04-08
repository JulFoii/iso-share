# Verwende ein leichtgewichtiges Node-Image (Alpine)
FROM node:16-alpine

# Setze das Arbeitsverzeichnis im Container
WORKDIR /app

# Kopiere die Package-Dateien und installiere die Abhängigkeiten
COPY package*.json ./
RUN npm install --production

# Kopiere den Rest des Quellcodes
COPY . .

# Öffne den Port, auf dem der Server laufen wird
EXPOSE 3000

# Starte die Anwendung
CMD ["node", "server.js"]
