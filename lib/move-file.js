'use strict';

const fsp = require('fs/promises');

/*
 * rename() scheitert mit EXDEV, wenn Quelle und Ziel auf verschiedenen Mounts
 * liegen — genau der Fall, wenn tmp-uploads/ im Container liegt und uploads/
 * ein Bind-Mount ist. Dann kopieren und die Quelle loeschen.
 */
async function moveFile(source, target) {
    try {
        await fsp.rename(source, target);
    } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        await fsp.copyFile(source, target);
        await fsp.rm(source, { force: true });
    }
}

module.exports = { moveFile };
