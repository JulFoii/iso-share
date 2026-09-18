'use strict';

/*
 * Automatisch aus dem ISO-9660-Volume-Descriptor abgeleitete Tags, damit man
 * sie nicht fuer jede Datei von Hand eintippen muss.
 *
 * Bewusst nur verlaessliche Felder: bootable/UEFI/BIOS aus dem El-Torito-
 * Boot-Katalog und die Volume-ID selbst. Einen Distro-/OS-Namen aus
 * volumeId/publisher zu *raten* waere zu uneinheitlich (Brenner-Strings,
 * Gross-/Kleinschreibung, Abkuerzungen) und wuerde eher falsche als
 * hilfreiche Tags erzeugen.
 */

const { safeTag } = require('./safe-name');

function deriveAutoTags(iso) {
    if (!iso) return [];

    const candidates = [];
    if (iso.bootable?.includes('BIOS')) candidates.push('BIOS');
    if (iso.bootable?.includes('UEFI')) candidates.push('UEFI');
    if (iso.volumeId) candidates.push(iso.volumeId);

    const seen = new Set();
    const tags = [];
    for (const raw of candidates) {
        const tag = safeTag(raw);
        if (!tag) continue;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        tags.push(tag);
    }
    return tags;
}

/*
 * Verrechnet neu abgeleitete Auto-Tags mit dem bisherigen Sidecar-Stand:
 *
 *  - kein Duplizieren bei jedem Rescan: ein Tag, das beim letzten Lauf schon
 *    automatisch gesetzt wurde, wird nicht ein zweites Mal angehaengt
 *  - ein vom Admin per DELETE entfernter Auto-Tag (in removedAutoTags,
 *    siehe server.js) kommt beim naechsten Rescan nicht wieder
 *  - manuell gesetzte Tags (alles in tags, was nicht in der letzten
 *    autoTags-Liste stand) bleiben unangetastet
 *  - aendert sich das Image (neue volumeId), verschwindet der alte
 *    Auto-Tag automatisch wieder, statt als Karteileiche stehen zu bleiben
 */
function applyAutoTags(meta, candidateTags, maxTags) {
    const existingTags = meta?.tags ?? [];
    const previousAuto = meta?.autoTags ?? [];
    const removedAuto = meta?.removedAutoTags ?? [];

    const previousAutoKeys = new Set(previousAuto.map(t => t.toLowerCase()));
    const removedKeys = new Set(removedAuto.map(t => t.toLowerCase()));

    const manualTags = existingTags.filter(t => !previousAutoKeys.has(t.toLowerCase()));
    const manualKeys = new Set(manualTags.map(t => t.toLowerCase()));

    const tags = [...manualTags];
    const autoTags = [];
    for (const tag of candidateTags) {
        const key = tag.toLowerCase();
        if (removedKeys.has(key) || manualKeys.has(key)) continue;
        if (tags.length >= maxTags) break;
        tags.push(tag);
        autoTags.push(tag);
    }

    return { tags, autoTags };
}

module.exports = { deriveAutoTags, applyAutoTags };
