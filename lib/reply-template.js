'use strict';

/*
 * Anrede und Grussformel fuer Support-Antworten. buildReplyDraft() setzt
 * beide als Vorbelegung direkt ins Antwortfeld des Admin-Composers — der
 * Admin sieht und bearbeitet also genau den Text, der rausgeht, und kann
 * Anrede oder Grussformel pro Antwort umformulieren oder loeschen. Der Server
 * fuegt beim Speichern nichts mehr hinzu; er prueft nur mit isOnlyTemplate(),
 * dass nicht die unveraenderte Vorlage ohne eigenen Text abgeschickt wird.
 *
 * Platzhalter: {name} (Kundenname) und {agent} (Anzeigename des Supporters).
 * Ohne Kundennamen wird aus "Hallo {name}," einfach "Hallo," statt
 * "Hallo ,". Reine Funktionen ohne DB, damit sie auch die Vorschau in den
 * Einstellungen und die Tests benutzen koennen.
 */

const REPLY_TEMPLATE_DEFAULTS = Object.freeze({
    greeting: 'Hallo {name},',
    signature: 'Mit freundlichen Grüßen\n{agent}\nISO Share Support',
    agentName: '',
});

const REPLY_TEMPLATE_LIMITS = { greeting: 200, signature: 500, agentName: 80 };

function fill(template, { name = '', agent = '' } = {}) {
    return String(template ?? '').replace(/\r\n/g, '\n').split('\n').flatMap(line => {
        const hadPlaceholder = /\{(name|agent)\}/.test(line);
        const filled = line
            .replace(/[ \t]*\{name\}/g, name ? ` ${name}` : '')
            .replace(/\{agent\}/g, agent)
            .trim();
        // Eine Zeile, die nur aus einem leeren Platzhalter bestand, entfaellt.
        return hadPlaceholder && !filled ? [] : [filled];
    }).join('\n').trim();
}

/* Vorbelegung fuers Antwortfeld: Anrede, eine Leerzeile, die Stelle fuer
   den eigenen Text, eine Leerzeile, Grussformel. `caret` ist die Position
   dieser Stelle, damit composer.js den Cursor genau dorthin setzen kann.
   Leere Vorlagen schalten den jeweiligen Teil ab; sind beide leer, bleibt
   das Feld leer. */
function buildReplyDraft({ greeting, signature, name, agent } = {}) {
    const hello = fill(greeting, { name, agent });
    const bye = fill(signature, { name, agent });
    if (!hello && !bye) return { value: '', caret: 0 };
    const head = hello ? `${hello}\n\n` : '';
    const tail = bye ? `\n\n${bye}` : '';
    return { value: `${head}${tail}`, caret: head.length };
}

/* true, wenn `body` nach Abzug der Vorbelegung leer ist — also nur die
   unveraenderte Anrede/Grussformel abgeschickt wurde. */
function isOnlyTemplate(body, draft) {
    const text = normalize(body);
    return text === '' || (draft !== '' && text === normalize(draft));
}

function normalize(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

module.exports = {
    REPLY_TEMPLATE_DEFAULTS, REPLY_TEMPLATE_LIMITS, buildReplyDraft, isOnlyTemplate,
};
