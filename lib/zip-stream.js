'use strict';

/*
 * Minimaler ZIP-Writer fuer den Bulk-Download (POST /download-zip), von Hand
 * statt per Abhaengigkeit: Format-Version 2.0, nur Methode "Store" (keine
 * Kompression) mit Data Descriptor — ISO-Images komprimieren ohnehin kaum,
 * und so muss der Server weder CRC32 noch Groesse VOR dem Streamen kennen,
 * sondern kann jede Datei direkt von der Platte in die Antwort schreiben.
 *
 * Bewusste Einschraenkung: keine Zip64-Erweiterung. Groesse, komprimierte
 * Groesse oder Offset ueber 4 GiB wuerden die klassischen 32-Bit-Felder
 * ueberlaufen lassen. server.js prueft das vorher mit fitsInClassicZip() und
 * lehnt eine zu grosse Auswahl mit einer klaren Fehlermeldung ab, statt ein
 * korruptes Archiv zu erzeugen.
 */

const fs = require('fs');
const { once } = require('events');

const ZIP64_LIMIT = 0xFFFFFFFF;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32Update(crc, buffer) {
    let c = crc ^ 0xFFFFFFFF;
    for (let i = 0; i < buffer.length; i++) {
        c = CRC_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/* Wanduhr-Bestandteile in der Zeitzone des Prozesses (Default) */
function localParts(date) {
    return {
        year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
        hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds(),
    };
}

/*
 * MS-DOS-Datum/Zeit, wie es das ZIP-Format in den Header-Feldern erwartet.
 * Das Format kennt keine Zeitzone — Entpacker lesen es als Ortszeit. Darum
 * uebergibt server.js die Anzeige-Zeitzone (lib/time.js), statt die des
 * Servers (im Container UTC) zu nehmen.
 */
function dosDateTime(date, parts = localParts) {
    let p = parts(date);
    if (p.year < 1980) p = { year: 1980, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
    const dosTime = (p.hour << 11) | (p.minute << 5) | Math.floor(p.second / 2);
    const dosDate = (((p.year - 1980) & 0x7f) << 9) | (p.month << 5) | p.day;
    return { dosTime, dosDate };
}

/*
 * Wartet bei Gegendruck auf 'drain' — bricht aber ab, sobald der Client die
 * Verbindung schliesst: ein geschlossener Response-Stream feuert nie wieder
 * 'drain', der Aufrufer (und der offene Lese-Stream der aktuellen Datei)
 * haengte sonst fuer immer.
 */
async function writeChunk(stream, buffer) {
    if (stream.destroyed) throw new Error('Stream bereits geschlossen');
    if (stream.write(buffer)) return;
    const ac = new AbortController();
    try {
        await Promise.race([
            once(stream, 'drain', { signal: ac.signal }),
            once(stream, 'close', { signal: ac.signal }).then(() => {
                throw new Error('Stream vorzeitig geschlossen');
            }),
        ]);
    } finally {
        ac.abort();
    }
}

function fitsInClassicZip(size) {
    return size <= ZIP64_LIMIT;
}

/*
 * files: [{ name, path, size, mtime }]
 * Schreibt das komplette Archiv in `stream` (z. B. die Express-Response) und
 * beendet sie NICHT selbst — der Aufrufer entscheidet, wann res.end() faellt.
 */
async function writeZip(stream, files, { parts = localParts } = {}) {
    const central = [];
    let offset = 0;

    for (const file of files) {
        const nameBuffer = Buffer.from(file.name, 'ascii');
        const { dosTime, dosDate } = dosDateTime(file.mtime ?? new Date(), parts);

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);      // version needed to extract
        localHeader.writeUInt16LE(0x0008, 6);  // flag bit 3: data descriptor folgt
        localHeader.writeUInt16LE(0, 8);       // method: store
        localHeader.writeUInt16LE(dosTime, 10);
        localHeader.writeUInt16LE(dosDate, 12);
        localHeader.writeUInt32LE(0, 14);      // crc32 — erst im Data Descriptor
        localHeader.writeUInt32LE(0, 18);      // compressed size — dito
        localHeader.writeUInt32LE(0, 22);      // uncompressed size — dito
        localHeader.writeUInt16LE(nameBuffer.length, 26);
        localHeader.writeUInt16LE(0, 28);      // extra field length

        const localHeaderOffset = offset;
        await writeChunk(stream, localHeader);
        await writeChunk(stream, nameBuffer);
        offset += localHeader.length + nameBuffer.length;

        let crc = 0;
        let size = 0;
        for await (const chunk of fs.createReadStream(file.path)) {
            crc = crc32Update(crc, chunk);
            size += chunk.length;
            await writeChunk(stream, chunk);
        }
        offset += size;

        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE(crc, 4);
        descriptor.writeUInt32LE(size, 8);
        descriptor.writeUInt32LE(size, 12);
        await writeChunk(stream, descriptor);
        offset += descriptor.length;

        central.push({ nameBuffer, crc, size, dosTime, dosDate, localHeaderOffset });
    }

    const centralStart = offset;
    for (const entry of central) {
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE(20, 4);   // version made by
        header.writeUInt16LE(20, 6);   // version needed
        header.writeUInt16LE(0x0008, 8);
        header.writeUInt16LE(0, 10);   // method: store
        header.writeUInt16LE(entry.dosTime, 12);
        header.writeUInt16LE(entry.dosDate, 14);
        header.writeUInt32LE(entry.crc, 16);
        header.writeUInt32LE(entry.size, 20);
        header.writeUInt32LE(entry.size, 24);
        header.writeUInt16LE(entry.nameBuffer.length, 28);
        header.writeUInt16LE(0, 30);   // extra length
        header.writeUInt16LE(0, 32);   // comment length
        header.writeUInt16LE(0, 34);   // disk number start
        header.writeUInt16LE(0, 36);   // internal attrs
        header.writeUInt32LE(0, 38);   // external attrs
        header.writeUInt32LE(entry.localHeaderOffset, 42);
        await writeChunk(stream, header);
        await writeChunk(stream, entry.nameBuffer);
        offset += header.length + entry.nameBuffer.length;
    }
    const centralSize = offset - centralStart;

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);
    await writeChunk(stream, end);
}

// dosDateTimeForTest: nur fuer test/time.test.js
module.exports = { writeZip, fitsInClassicZip, crc32Update, dosDateTimeForTest: dosDateTime };
