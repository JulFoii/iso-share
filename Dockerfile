# Basisimage wählen
FROM node:16-alpine

# Arbeitsverzeichnis festlegen
WORKDIR /app

# Nur die für die Installation benötigten Dateien kopieren
COPY package*.json ./

# Abhängigkeiten installieren
RUN npm install

# Restlichen Code kopieren
COPY . .

# Falls kein Build-Schritt erforderlich ist, entferne oder kommentiere den folgenden Befehl:
# RUN npm run build

# Exponierten Port deklarieren (anpassen, falls nötig)
EXPOSE 3000

# Startbefehl für die Anwendung
CMD ["npm", "start"]
