'use strict';

/*
 * Baut ein minimales, aber normgerechtes ISO-9660-Image im Speicher, damit die
 * Tests keine echte Distro-ISO als Fixture brauchen. Enthalten sind genau die
 * Deskriptoren, die lib/iso9660.js liest.
 */

const SECTOR = 2048;

function writeFixed(buf, offset, text, length, pad = ' ') {
    const value = String(text).slice(0, length).padEnd(length, pad);
    buf.write(value, offset, length, 'latin1');
}

function primaryVolumeDescriptor({ volumeId, blocks, createdAt, publisher }) {
    const buf = Buffer.alloc(SECTOR);
    buf[0] = 1;                                    // Typ: Primary
    writeFixed(buf, 1, 'CD001', 5);
    buf[6] = 1;                                    // Version
    writeFixed(buf, 8, 'LINUX', 32);               // System Identifier
    writeFixed(buf, 40, volumeId, 32);             // Volume Identifier
    buf.writeUInt32LE(blocks, 80);                 // Volume Space Size (LE)
    buf.writeUInt32BE(blocks, 84);                 //                   (BE)
    buf.writeUInt16LE(SECTOR, 128);                // Logical Block Size (LE)
    buf.writeUInt16BE(SECTOR, 130);                //                    (BE)
    writeFixed(buf, 318, publisher ?? '', 128);
    // 16 Ziffern plus ein *binaeres* Byte mit dem Zeitzonen-Offset in
    // 15-Minuten-Schritten. 0 = UTC — als ASCII '0' waeren es +12 h.
    writeFixed(buf, 813, createdAt ?? '0'.repeat(16), 16, '0');
    buf[829] = 0;
    return buf;
}

function bootRecord(catalogSector) {
    const buf = Buffer.alloc(SECTOR);
    buf[0] = 0;                                    // Typ: Boot Record
    writeFixed(buf, 1, 'CD001', 5);
    buf[6] = 1;
    writeFixed(buf, 7, 'EL TORITO SPECIFICATION', 32, '\0');
    buf.writeUInt32LE(catalogSector, 71);
    return buf;
}

function terminator() {
    const buf = Buffer.alloc(SECTOR);
    buf[0] = 255;
    writeFixed(buf, 1, 'CD001', 5);
    buf[6] = 1;
    return buf;
}

/* Validation Entry + ein Section Header je zusaetzlicher Plattform */
function bootCatalog(platformIds) {
    const buf = Buffer.alloc(SECTOR);
    buf[0] = 0x01;                                 // Header ID: Validation
    buf[1] = platformIds[0];
    writeFixed(buf, 4, 'ISO SHARE TEST', 24, '\0');
    buf[30] = 0x55;
    buf[31] = 0xaa;

    const rest = platformIds.slice(1);
    rest.forEach((id, index) => {
        const offset = 32 + index * 32;
        buf[offset] = index === rest.length - 1 ? 0x91 : 0x90;
        buf[offset + 1] = id;
        buf.writeUInt16LE(1, offset + 2);
    });
    return buf;
}

/*
 * platformIds: El-Torito-IDs (0x00 = BIOS, 0xef = UEFI). Leeres Array laesst
 * den Boot-Record weg, das Image ist dann nicht bootfaehig.
 */
function makeIso({
    volumeId = 'ISO_SHARE_TEST',
    platformIds = [0x00, 0xef],
    createdAt = '2026010112300000',
    publisher = 'ISO SHARE',
    padSectors = 4,
} = {}) {
    const bootable = platformIds.length > 0;
    const sectors = [
        Buffer.alloc(FIRST_DESCRIPTOR_SECTOR * SECTOR),   // System-Bereich
    ];

    const catalogSector = bootable ? 19 : 0;
    sectors.push(primaryVolumeDescriptor({
        volumeId,
        blocks: FIRST_DESCRIPTOR_SECTOR + 3 + padSectors,
        createdAt,
        publisher,
    }));
    if (bootable) sectors.push(bootRecord(catalogSector));
    sectors.push(terminator());
    if (bootable) {
        // Terminator liegt auf Sektor 18, der Katalog soll auf 19 landen
        sectors.push(bootCatalog(platformIds));
    }
    sectors.push(Buffer.alloc(padSectors * SECTOR));

    return Buffer.concat(sectors);
}

const FIRST_DESCRIPTOR_SECTOR = 16;

module.exports = { makeIso, SECTOR };
