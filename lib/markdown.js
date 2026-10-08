'use strict';

/*
 * Kleines, abhaengigkeitsfreies Markdown-Subset fuer die Artikel der
 * Wissensdatenbank (lib/kb-store.js). Bewusst kein vollstaendiger
 * CommonMark-Parser — nur, was ein FAQ-Artikel braucht:
 *
 *   # / ## / ###            Ueberschriften (h2–h4 relativ zur groessten
 *                           benutzten Ebene, h1 ist der Titel)
 *   - Punkt / * Punkt       Aufzaehlung
 *   1. Schritt              nummerierte Liste
 *   ```                     Codeblock (z. B. "sha256sum -c SHA256SUMS")
 *   **fett**, *kursiv*, `code`, [Text](https://…), nackte https://-URLs
 *
 * Sicherheit: der gesamte Text wird ZUERST escaped, erst danach werden die
 * Markdown-Konstrukte in (feste) Tags uebersetzt — rohes HTML im Artikel
 * bleibt also immer sichtbarer Text. Links nur zu http(s):, mailto: und
 * relativen Pfaden ab "/"; alles andere (javascript:, data:, //host …) bleibt
 * unverlinkter Text. Externe Links bekommen rel="noopener noreferrer".
 */

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* url kommt bereits escaped an (&amp; …) — fuer die Pruefung zurueck. */
function safeHref(escapedUrl) {
    const raw = escapedUrl.replace(/&amp;/g, '&');
    // Kein Backslash im relativen Pfad: Browser lesen "/\evil.example" wie
    // "//evil.example" (protokollrelativ, fremder Host).
    if (/^https?:\/\/[^\s\\]+$/i.test(raw) || /^mailto:[^\s]+$/i.test(raw) || /^\/(?![/\\])[^\s\\]*$/.test(raw)) {
        return escapedUrl;
    }
    return null;
}

function anchor(href, label) {
    const external = /^https?:/i.test(href);
    return `<a href="${href}"${external ? ' rel="noopener noreferrer"' : ''}>${label}</a>`;
}

/* Inline-Formatierung auf bereits escaptem Text (ohne Code-Spans). Links
   werden erst durch Platzhalter ersetzt, damit Fett/Kursiv/Autolink nicht
   in Attributwerte hineinwirken. */
function inlineFormat(escaped) {
    const slots = [];
    const hold = html => `\u0000${slots.push(html) - 1}\u0000`;

    let text = escaped.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (match, label, url) => {
        const href = safeHref(url);
        return href ? hold(anchor(href, label)) : match;
    });
    // Nackte URLs. Der Text ist schon escaped: ein umschliessendes "…" oder
    // <…> steht hier als &quot;/&#39;/&lt;/&gt; und beendet die URL.
    // Abschliessende Satzzeichen und eine schliessende Klammer ohne
    // oeffnende in der URL ("(siehe https://…)") gehoeren nicht dazu.
    text = text.replace(/\bhttps?:\/\/(?:(?!&quot;|&#39;|&lt;|&gt;)[^\s<\u0000])+/gi, match => {
        let url = match;
        for (;;) {
            const punct = /[.,;:!?]+$/.exec(url);
            if (punct) {
                url = url.slice(0, -punct[0].length);
            } else if (url.endsWith(')') && url.split('(').length < url.split(')').length) {
                url = url.slice(0, -1);
            } else {
                break;
            }
        }
        const href = safeHref(url);
        return href ? hold(anchor(href, url)) + match.slice(url.length) : match;
    });
    text = text
        // Fett darf Kursives enthalten ("**fett *kursiv* fett**")
        .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<em>$2</em>');
    // eslint-disable-next-line no-control-regex
    return text.replace(/\u0000(\d+)\u0000/g, (match, index) => slots[Number(index)] ?? '');
}

function inline(source) {
    // Code-Spans zuerst herausloesen: in ihnen gilt keine Formatierung.
    return String(source).split(/(`[^`\n]+`)/g).map((part, index) => {
        if (index % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
        return inlineFormat(escapeHtml(part));
    }).join('');
}

function renderMarkdown(source) {
    // eslint-disable-next-line no-control-regex
    const lines = String(source ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').split('\n');
    const out = [];
    // Die groesste im Artikel benutzte Ueberschrift wird h2 (h1 ist der
    // Seitentitel) — egal ob der Autor mit "#" oder, wie der Editor-Hinweis
    // vorschlaegt, mit "##" anfaengt. Sonst folgte auf h1 direkt h3.
    let inFence = false;
    let topLevel = 3;
    for (const line of lines) {
        if (/^\s*```/.test(line)) inFence = !inFence;
        const hashes = !inFence && /^(#{1,3})\s+\S/.exec(line);
        if (hashes) topLevel = Math.min(topLevel, hashes[1].length);
    }
    let paragraph = [];
    let list = null; // { tag, items }

    const flushParagraph = () => {
        if (paragraph.length) out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
        paragraph = [];
    };
    const flushList = () => {
        // "3. Schritt" als erster Punkt: die Liste beginnt auch bei 3
        const start = list?.start > 1 ? ` start="${list.start}"` : '';
        if (list) out.push(`<${list.tag}${start}>${list.items.map(item => `<li>${inline(item)}</li>`).join('')}</${list.tag}>`);
        list = null;
    };

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];

        if (/^\s*```/.test(line)) {
            flushParagraph();
            flushList();
            const code = [];
            i += 1;
            while (i < lines.length && !/^\s*```/.test(lines[i])) {
                code.push(lines[i]);
                i += 1;
            }
            out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
            continue;
        }

        const heading = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
        if (heading) {
            flushParagraph();
            flushList();
            const level = heading[1].length - topLevel + 2;
            out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
            continue;
        }

        const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
        const numbered = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line);
        if (bullet || numbered) {
            flushParagraph();
            const tag = bullet ? 'ul' : 'ol';
            if (list && list.tag !== tag) flushList();
            if (!list) list = { tag, items: [], start: numbered ? Number(numbered[1]) : 1 };
            list.items.push(bullet ? bullet[1] : numbered[2]);
            continue;
        }

        if (!line.trim()) {
            flushParagraph();
            flushList();
            continue;
        }

        // Eingerueckte Folgezeile gehoert noch zum letzten Listenpunkt
        if (list && /^\s{2,}\S/.test(line)) {
            list.items[list.items.length - 1] += ` ${line.trim()}`;
            continue;
        }
        flushList();
        paragraph.push(line.trim());
    }
    flushParagraph();
    flushList();
    return out.join('\n');
}

/* Klartext-Auszug fuer Listen und Vorschlaege: Markdown-Zeichen entfernt,
   Leerraum zusammengefasst, auf maxLength gekuerzt. */
function plainExcerpt(source, maxLength = 160) {
    const text = String(source ?? '')
        .replace(/```[\s\S]*?(```|$)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^\s*(#{1,3}|[-*]|\d{1,3}[.)])\s+/gm, '')
        .replace(/[*`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

module.exports = { renderMarkdown, plainExcerpt, escapeHtml };
