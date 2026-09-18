'use strict';

/*
 * Liest die Metadaten eines ISO-Images direkt aus dem Volume-Descriptor,
 * ohne das Image zu mounten oder ein externes Tool aufzurufen.
 *
 * Aufbau nach ECMA-119: Sektor 0-15 sind der System-Bereich, ab Sektor 16
 * (Offset 32768) folgen die Volume Descriptors je 2048 Byte, bis Typ 255 den
 * Satz abschliesst. Wir brauchen zwei davon:
 *
 *   Typ 1   Primary Volume Descriptor — Volume-Label, Groesse, Erstelldatum
 *   Typ 0   Boot Record — bei "EL TORITO SPECIFICATION" zeigt es auf den
 *           Boot-Katalog, aus dem sich BIOS- bzw. UEFI-Bootfaehigkeit ergibt
 *
 * Alle Offsets unten sind 0-basiert innerhalb des jeweiligen 2048-Byte-Blocks.
 * Die Norm zaehlt ab 1, deshalb steht das Label bei uns auf 40 und nicht 41.
 *
 * Grundsatz: diese Funktion wirft nie. Ein ISO kann beliebig kaputt oder gar
 * kein ISO sein — dann fehlen einzelne Felder oder es kommt null zurueck.
 */

const fsp = require('fs/promises');

const SECTOR = 2048;
const FIRST_DESCRIPTOR = 16 * SECTOR;
const MAX_DESCRIPTORS = 24;          // in der Praxis sind es 3-5
const STANDARD_ID = 'CD001';

const PLATFORMS = {
    0x00: 'BIOS',
    0x01: 'PowerPC',
    0x02: 'Mac',
    0xef: 'UEFI',
};

/* Feste Felder im Primary Volume Descriptor */
const PVD = {
    systemId: [8, 32],
    volumeId: [40, 32],
    volumeSpaceSize: 80,             // LE-Haelfte des both-endian-Werts
    logicalBlockSize: 128,           // dito
    volumeSetId: [190, 128],
    publisher: [318, 128],
    preparer: [446, 128],
    application: [574, 128],
    createdAt: [813, 17],
};

/*
 * a-/d-characters der Norm sind ASCII, mit Leerzeichen aufgefuellt. Manche
 * Brenner fuellen stattdessen mit NUL, darum beides abschneiden. Nicht
 * druckbare Zeichen fliegen raus, damit nichts Merkwuerdiges in die View geht.
 */
function readString(buf, [offset, length]) {
    const raw = buf.subarray(offset, offset + length).toString('latin1');
    const cleaned = raw.replace(/[\0\s]+$/, '').replace(/[^\x20-\x7e]/g, '');
    return cleaned.length > 0 ? cleaned : null;
}

/*
 * 17-Byte-Zeitstempel: "YYYYMMDDHHMMSSCC" plus ein vorzeichenbehaftetes Byte
 * mit dem Zeitzonen-Offset in 15-Minuten-Schritten. Ein ungesetztes Feld
 * besteht aus Nullen oder Leerzeichen.
 */
function readTimestamp(buf, [offset, length]) {
    const text = buf.subarray(offset, offset + length).toString('latin1');
    const digits = text.slice(0, 16);
    if (!/^\d{16}$/.test(digits)) return null;

    const year = Number(digits.slice(0, 4));
    if (year < 1970 || year > 2200) return null;

    const tzQuarters = buf.readInt8(offset + 16);
    const utc = Date.UTC(
        year,
        Number(digits.slice(4, 6)) - 1,
        Number(digits.slice(6, 8)),
        Number(digits.slice(8, 10)),
        Number(digits.slice(10, 12)),
        Number(digits.slice(12, 14)),
        Number(digits.slice(14, 16)) * 10
    );
    if (Number.isNaN(utc)) return null;
    // Der Offset ist die Zone, in der die Zeit notiert wurde — zum UTC-Wert
    // also abziehen.
    return new Date(utc - tzQuarters * 15 * 60 * 1000).toISOString();
}

/*
 * El-Torito-Boot-Katalog. Der erste 32-Byte-Eintrag ist die Validation Entry
 * (Header 0x01, endet auf 0x55 0xAA), danach folgen Default Entry und
 * beliebig viele Section Header (0x90 = weitere folgen, 0x91 = letzter). Die
 * Platform-ID steht in jedem Header auf Byte 1 — genau die sammeln wir.
 */
function readBootPlatforms(catalog) {
    if (catalog.length < 32) return [];
    if (catalog[0] !== 0x01) return [];
    if (catalog[30] !== 0x55 || catalog[31] !== 0xaa) return [];

    const platforms = new Set([catalog[1]]);

    for (let offset = 32; offset + 32 <= catalog.length; offset += 32) {
        const indicator = catalog[offset];
        if (indicator === 0x90 || indicator === 0x91) {
            platforms.add(catalog[offset + 1]);
            if (indicator === 0x91) break;
        } else if (indicator === 0x00 && catalog[offset + 1] === 0x00) {
            break;                   // ausgenullter Rest des Katalogs
        }
    }

    return [...platforms]
        .map(id => PLATFORMS[id])
        .filter(Boolean)
        .sort();
}

async function readIsoInfo(filePath) {
    let handle;
    try {
        handle = await fsp.open(filePath, 'r');
    } catch {
        return null;
    }

    try {
        const info = { volumeId: null, bootable: [] };
        const buf = Buffer.alloc(SECTOR);
        let sawPrimary = false;
        let bootCatalogSector = null;

        for (let index = 0; index < MAX_DESCRIPTORS; index++) {
            const position = FIRST_DESCRIPTOR + index * SECTOR;
            const { bytesRead } = await handle.read(buf, 0, SECTOR, position);
            if (bytesRead < SECTOR) break;
            if (buf.subarray(1, 6).toString('latin1') !== STANDARD_ID) break;

            const type = buf[0];
            if (type === 255) break;              // Terminator

            if (type === 1 && !sawPrimary) {
                sawPrimary = true;
                info.systemId = readString(buf, PVD.systemId);
                info.volumeId = readString(buf, PVD.volumeId);
                info.volumeSetId = readString(buf, PVD.volumeSetId);
                info.publisher = readString(buf, PVD.publisher);
                info.preparer = readString(buf, PVD.preparer);
                info.application = readString(buf, PVD.application);
                info.createdAt = readTimestamp(buf, PVD.createdAt);

                const blocks = buf.readUInt32LE(PVD.volumeSpaceSize);
                const blockSize = buf.readUInt16LE(PVD.logicalBlockSize);
                info.volumeSize =
                    blockSize > 0 ? blocks * blockSize : null;
            } else if (type === 0 && bootCatalogSector === null) {
                const bootSystem = readString(buf, [7, 32]) || '';
                if (bootSystem.startsWith('EL TORITO')) {
                    bootCatalogSector = buf.readUInt32LE(71);
                }
            }
        }

        if (!sawPrimary) return null;             // kein ISO-9660-Dateisystem

        if (bootCatalogSector !== null && bootCatalogSector > 0) {
            const catalog = Buffer.alloc(SECTOR);
            const { bytesRead } = await handle.read(
                catalog, 0, SECTOR, bootCatalogSector * SECTOR
            );
            if (bytesRead >= 32) {
                info.bootable = readBootPlatforms(catalog.subarray(0, bytesRead));
            }
        }

        return info;
    } catch {
        return null;                              // abgeschnitten o. beschaedigt
    } finally {
        await handle.close().catch(() => {});
    }
}

module.exports = { readIsoInfo };
