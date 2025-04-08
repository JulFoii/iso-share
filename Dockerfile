# Basisimage wählen (zum Beispiel eine Node.js-Version)
FROM node:16-alpine

# Arbeitsverzeichnis festlegen
WORKDIR /app

# Nur die für die Installation benötigten Dateien kopieren
COPY package*.json ./

# Abhängigkeiten installieren
RUN npm install

# Restlichen Code kopieren
COPY . .

# Falls Dein Projekt einen Build-Schritt hat (z.B. "npm run build"), diesen ausführen
RUN npm run build

# Exponierten Port deklarieren (anpassen, falls nötig)
EXPOSE 3000

# Startbefehl für die Anwendung
CMD ["npm", "start"]
