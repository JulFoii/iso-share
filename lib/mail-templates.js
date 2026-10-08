'use strict';

/*
 * Mail-Vorlagen im Design der App (public/css/tokens.css): gleiche Farben,
 * gleiche Schrift, dieselben Bausteine — Karte, Status-Badge, Nachrichten-
 * Blase mit Avatar, Primaerbutton. Jede Mail wird aus einer kleinen Struktur
 * gebaut, aus der compose() Klartext- UND HTML-Teil erzeugt; beide koennen
 * so nie inhaltlich auseinanderlaufen.
 *
 * Mail-Clients koennen kein oklch() und keine CSS-Variablen, darum stehen
 * die Tokens hier als Hex-Werte (exakt aus tokens.css umgerechnet). Hell ist
 * die Grundlage und steht inline — das sehen alle Clients. Der dunkle Modus
 * kommt per @media (prefers-color-scheme: dark) mit !important obendrauf
 * (Apple Mail, iOS/macOS, Outlook.com/-App, Thunderbird); Gmail ignoriert
 * das und zeigt die helle Variante bzw. invertiert selbst.
 *
 * Alles aus Nutzereingaben (Betreff, Nachricht, Name) laeuft durch
 * escapeHtml(); es gibt keinen Weg, rohes HTML in eine Mail zu bekommen.
 * Links kommen nur aus PUBLIC_URL (siehe lib/ticket-mail.js), nie aus einer
 * Anfrage. Layout per Tabellen und Inline-Styles, weil viele Clients
 * Flexbox/Grid und externe Stylesheets verwerfen — die Details, was das fuer
 * Outlook fuer Windows (Word-Engine) heisst, stehen bei den HTML-Bausteinen.
 */

const REPLY_MARKER = '## Bitte oberhalb dieser Zeile antworten ##';

const LIGHT = {
    page: '#f3f3f5', surface: '#ffffff', sunken: '#f3f3f5', border: '#e1e1e4', borderStrong: '#cdcdd2',
    text: '#18181b', muted: '#52525a', subtle: '#797981', accent: '#1c45c2',
    btnBg: '#18181b', btnFg: '#ffffff',
    success: '#007145', warning: '#855a00', pending: '#006e9a', danger: '#c11435',
};

const DARK = {
    page: '#050506', surface: '#0e0e10', sunken: '#070708', border: '#252529', borderStrong: '#36363c',
    text: '#f3f3f5', muted: '#a0a1a9', subtle: '#71717a', accent: '#88a7fd',
    btnBg: '#f8f8f8', btnFg: '#050506',
    success: '#3ad693', warning: '#f1b638', pending: '#5dbee9', danger: '#fa6773',
};

const FONT = "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO = "ui-monospace,'SF Mono','Cascadia Mono',Menlo,Consolas,monospace";

// Status-Farben wie .status--* in public/css/tickets.css
const STATUS_COLOR = { new: 'accent', open: 'warning', pending: 'pending', resolved: 'success', closed: 'subtle' };

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* Mischt zwei Hex-Farben — ersetzt color-mix(), das Mail-Clients nicht
   kennen (fuer die zarten Badge-/Blasen-Hintergruende). */
function mix(a, b, weight) {
    const parse = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    const [ca, cb] = [parse(a), parse(b)];
    return `#${ca.map((v, i) => Math.round(v * weight + cb[i] * (1 - weight)).toString(16).padStart(2, '0')).join('')}`;
}

function initials(name) {
    const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/* Dunkler Modus: pro Klasse die dunkle Variante. Farbnamen der Badges/
   Blasen werden hier genauso aus DARK gemischt wie inline aus LIGHT. */
function darkStyles() {
    const d = DARK;
    const rules = [
        `.m-page{background:${d.page}!important}`,
        `.m-card{background:${d.surface}!important;border-color:${d.border}!important}`,
        `.m-sunken{background:${d.sunken}!important;border-color:${d.border}!important}`,
        `.m-divider{border-color:${d.border}!important}`,
        `.m-text{color:${d.text}!important}`,
        `.m-muted{color:${d.muted}!important}`,
        `.m-subtle{color:${d.subtle}!important}`,
        `.m-link{color:${d.accent}!important}`,
        `.m-btn{background:${d.btnBg}!important;color:${d.btnFg}!important}`,
        `.m-logo{border-color:${d.accent}!important}`,
        `.m-logo-dot{background:${d.accent}!important}`,
        `.m-bubble{background:${d.surface}!important;border-color:${d.border}!important}`,
        `.m-bubble-mine{background:${mix(d.accent, d.surface, 0.07)}!important;border-color:${mix(d.accent, d.border, 0.22)}!important}`,
        `.m-avatar-admin{background:${d.btnBg}!important;color:${d.btnFg}!important}`,
        `.m-avatar-customer{background:${mix(d.accent, d.surface, 0.14)}!important;color:${d.accent}!important}`,
    ];
    for (const [status, key] of Object.entries(STATUS_COLOR)) {
        const color = d[key];
        rules.push(`.m-status-${status}{background:${mix(color, d.surface, 0.14)}!important;border-color:${mix(color, d.border, 0.35)}!important;color:${color}!important}`);
    }
    return rules.join('\n');
}

const DARK_CSS = darkStyles();

/* Outlook.com und die Outlook-Apps kennen prefers-color-scheme nicht, faerben
   im Darkmode aber selbst um und markieren das mit data-ogsc (Textfarbe)
   bzw. data-ogsb (Hintergrund) an einem Elternelement. Dieselben Regeln
   darunter gehaengt ergeben dort dieselben dunklen Farben wie in der App,
   statt der automatischen Invertierung. */
const OUTLOOK_DARK_CSS = DARK_CSS.split('\n')
    .flatMap(rule => [`[data-ogsc] ${rule}`, `[data-ogsb] ${rule}`])
    .join('\n');

/* ------------------------------------------------------------------------
 * HTML-Bausteine. Regeln, die fuer JEDEN Client gelten (Outlook fuer Windows
 * rendert mit der Word-Engine und ist der kleinste gemeinsame Nenner):
 *
 *  - Abstaende, Hintergruende und Rahmen nur an <td> (bgcolor-Attribut plus
 *    Inline-Style), nie an <div>/<span>/<a> — Word ignoriert dort padding.
 *  - Feste Breite per MSO-"Ghost-Table", weil Word max-width nicht kennt.
 *  - Zeilenumbrueche als <br>, nicht white-space:pre-wrap (kennt Word nicht).
 *  - Zeilenhoehen in px mit mso-line-height-rule:exactly.
 *  - Kreise (Logo, Avatar) und der runde Button als VML nur fuer Outlook
 *    (<!--[if mso]>), alle anderen bekommen das normale HTML
 *    (<!--[if !mso]><!-->). So sieht es ueberall gleich aus; einzig die
 *    abgerundeten Ecken der grossen Karte bleiben in Outlook fuer Windows
 *    eckig — das kann Word ohne erheblich fragileres VML nicht.
 *  - Schrift: Word faellt bei einer unbekannten ersten Schrift der Liste
 *    auf Times New Roman zurueck, darum ein MSO-Override auf Segoe UI.
 * --------------------------------------------------------------------- */

const WIDTH = 580;
const T = 'role="presentation" border="0" cellpadding="0" cellspacing="0"';
const MSO_FONT = "'Segoe UI',Arial,sans-serif";

function font(size, lineHeight, extra = '') {
    return `font-family:${FONT};font-size:${size}px;line-height:${lineHeight}px;mso-line-height-rule:exactly;${extra}`;
}

/* Nutzertext: escapen, Zeilenumbrueche zu <br>, mehrere Leerzeichen
   erhalten (ersetzt white-space:pre-wrap). */
function textToHtml(value) {
    return escapeHtml(String(value ?? '').replace(/\r\n/g, '\n'))
        .replace(/ {2}/g, ' &nbsp;')
        .replace(/\n/g, '<br>');
}

function spacer(height) {
    return `<table ${T} width="100%"><tr><td height="${height}" style="height:${height}px;font-size:0;line-height:0;mso-line-height-rule:exactly">&nbsp;</td></tr></table>`;
}

function circle({ size, className, bg, fg, label }) {
    return `<!--[if mso]><v:oval style="width:${size}px;height:${size}px;v-text-anchor:middle" fillcolor="${bg}" stroked="f"><v:textbox inset="0,0,0,0"><center style="font-family:${MSO_FONT};font-size:12px;font-weight:bold;color:${fg}">${label}</center></v:textbox></v:oval><![endif]-->` +
        `<!--[if !mso]><!--><table ${T}><tr><td class="${className}" width="${size}" height="${size}" align="center" valign="middle" bgcolor="${bg}" ` +
        `style="width:${size}px;height:${size}px;border-radius:999px;background:${bg};color:${fg};${font(12, size, 'font-weight:700;')}">${label}</td></tr></table><!--<![endif]-->`;
}

function logoHtml() {
    const a = LIGHT.accent;
    return `<!--[if mso]><v:group style="width:18px;height:18px" coordsize="18,18" coordorigin="0,0">` +
        `<v:oval style="position:absolute;left:1;top:1;width:16;height:16" strokecolor="${a}" strokeweight="1.5pt" filled="f"></v:oval>` +
        `<v:oval style="position:absolute;left:6;top:6;width:6;height:6" fillcolor="${a}" stroked="f"></v:oval></v:group><![endif]-->` +
        `<!--[if !mso]><!--><table ${T}><tr><td class="m-logo" width="14" height="14" align="center" valign="middle" ` +
        `style="width:14px;height:14px;border:2px solid ${a};border-radius:999px;font-size:0;line-height:0">` +
        `<table ${T} align="center"><tr><td class="m-logo-dot" width="6" height="6" bgcolor="${a}" ` +
        `style="width:6px;height:6px;border-radius:999px;background:${a};font-size:0;line-height:0">&nbsp;</td></tr></table>` +
        `</td></tr></table><!--<![endif]-->`;
}

function statusPill(status, label) {
    const color = LIGHT[STATUS_COLOR[status] ?? 'subtle'];
    const bg = mix(color, LIGHT.surface, 0.1);
    return `<table ${T} style="border-collapse:separate"><tr><td class="m-status-${escapeHtml(status)}" bgcolor="${bg}" ` +
        `style="padding:3px 10px;border:1px solid ${mix(color, LIGHT.border, 0.35)};border-radius:999px;background:${bg};color:${color};` +
        `${font(12, 16, 'font-weight:600;white-space:nowrap;')}">&#9679;&nbsp;${escapeHtml(label)}</td></tr></table>`;
}

function paragraphHtml(text, { small = false } = {}) {
    const style = small
        ? `margin:0 0 12px;${font(13, 20)}color:${LIGHT.muted}`
        : `margin:0 0 14px;${font(15, 24)}color:${LIGHT.text}`;
    return `<p class="${small ? 'm-muted' : 'm-text'}" style="${style}">${textToHtml(text)}</p>`;
}

/* Nachrichten-Blase wie im Ticket-Verlauf der App (partials/ticket-message). */
function bubbleHtml(quote) {
    const isAdmin = quote.author === 'admin';
    const avatar = isAdmin
        ? circle({ size: 32, className: 'm-avatar-admin', bg: LIGHT.btnBg, fg: LIGHT.btnFg, label: 'S' })
        : circle({
            size: 32, className: 'm-avatar-customer', bg: mix(LIGHT.accent, LIGHT.surface, 0.12), fg: LIGHT.accent,
            label: escapeHtml(initials(quote.name || quote.label)),
        });
    const bubbleClass = isAdmin ? 'm-bubble' : 'm-bubble-mine';
    const bg = isAdmin ? LIGHT.surface : mix(LIGHT.accent, LIGHT.surface, 0.06);
    const border = isAdmin ? LIGHT.border : mix(LIGHT.accent, LIGHT.border, 0.22);
    return `
<table ${T} width="100%"><tr>
  <td width="32" valign="top" style="width:32px;padding-top:2px">${avatar}</td>
  <td width="12" style="width:12px;font-size:0;line-height:0">&nbsp;</td>
  <td valign="top">
    <table ${T} width="100%" style="border-collapse:separate"><tr>
      <td class="${bubbleClass}" bgcolor="${bg}" style="padding:14px 16px;background:${bg};border:1px solid ${border};border-radius:4px 14px 14px 14px">
        <p class="m-text" style="margin:0 0 6px;${font(13, 18, 'font-weight:600;')}color:${LIGHT.text}">${escapeHtml(quote.label)}</p>
        <p class="m-text" style="margin:0;${font(15, 24)}color:${LIGHT.text};word-break:break-word">${textToHtml(quote.body)}</p>
      </td>
    </tr></table>
  </td>
</tr></table>
${spacer(18)}`;
}

/* Anhang-Chips: nebeneinander, wo inline-block geht; Outlook stapelt sie
   untereinander, bleibt dabei aber lesbar. */
function attachmentsHtml(names) {
    const chips = names.map(name => `<table ${T} style="display:inline-block;border-collapse:separate;margin:0 6px 6px 0"><tr>` +
        `<td class="m-sunken m-text" bgcolor="${LIGHT.sunken}" style="padding:4px 10px;border:1px solid ${LIGHT.border};border-radius:8px;` +
        `background:${LIGHT.sunken};color:${LIGHT.text};${font(12, 18)}">&#128206;&nbsp;${escapeHtml(name)}</td></tr></table>`).join('');
    return `<table ${T} width="100%"><tr><td style="padding:0 0 10px 44px">${chips}</td></tr></table>`;
}

/* "Bulletproof" Button: VML-roundrect fuer Outlook, sonst ein normaler
   Link mit Padding. Die VML-Breite muss fest sein, darum geschaetzt. */
function buttonHtml(button) {
    const url = escapeHtml(button.url);
    const label = escapeHtml(button.label);
    const width = Math.round(String(button.label).length * 8.2 + 64);
    return `
${spacer(8)}
<table ${T}><tr><td>
<!--[if mso]><v:roundrect href="${url}" style="height:44px;width:${width}px;v-text-anchor:middle" arcsize="23%" stroked="f" fillcolor="${LIGHT.btnBg}"><w:anchorlock/><center style="font-family:${MSO_FONT};font-size:14px;font-weight:bold;color:${LIGHT.btnFg}">${label}&nbsp;&rarr;</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a class="m-btn" href="${url}" style="display:inline-block;padding:12px 22px;border-radius:10px;background:${LIGHT.btnBg};color:${LIGHT.btnFg};${font(14, 20, 'font-weight:600;')}text-decoration:none">${label}&nbsp;&rarr;</a><!--<![endif]-->
</td></tr></table>
<p class="m-subtle" style="margin:12px 0 18px;${font(12, 18)}color:${LIGHT.subtle};word-break:break-all">
  Oder im Browser öffnen: <a class="m-link" href="${url}" style="color:${LIGHT.accent}">${url}</a>
</p>`;
}

/*
 * blocks: {
 *   subject, preheader, heading, paragraphs[],
 *   ticket: {number, subject, status, statusLabel} | null,
 *   quote: {label, body, author: 'admin'|'customer', name} | null,
 *   attachments: string[], button: {label, url} | null, after: string[],
 *   replyable: bool, footer, footerLinks: [{label, url}]
 * }
 */
function compose({
    appName, heading, preheader = '', paragraphs = [], ticket = null, quote = null, attachments = [],
    button = null, after = [], replyable = false, footer = null, footerLinks = [],
}) {
    /* ------------------------------------------------------ Klartext -- */
    const textParts = [];
    if (replyable) textParts.push(REPLY_MARKER, '');
    if (ticket) textParts.push(`Ticket #${ticket.number} · ${ticket.subject} · Status: ${ticket.statusLabel}`, '');
    textParts.push(heading, '');
    for (const p of paragraphs) textParts.push(p, '');
    if (quote) {
        textParts.push(`${quote.label}:`, '');
        textParts.push(...String(quote.body).split('\n').map(line => `  ${line}`), '');
    }
    if (attachments.length) textParts.push(`Anhänge: ${attachments.join(', ')}`, '');
    if (button) textParts.push(`${button.label}: ${button.url}`, '');
    for (const p of after) textParts.push(p, '');
    textParts.push('—', footer || appName);
    for (const link of footerLinks) textParts.push(`${link.label}: ${link.url}`);
    const text = textParts.join('\n');

    /* ---------------------------------------------------------- HTML -- */
    const ticketHead = ticket ? `
<tr><td class="m-divider m-pad" style="padding:18px 28px;border-bottom:1px solid ${LIGHT.border}">
  <table ${T} width="100%"><tr>
    <td class="m-subtle" valign="middle" style="font-family:${MONO};font-size:13px;line-height:20px;mso-line-height-rule:exactly;color:${LIGHT.subtle}">#${escapeHtml(ticket.number)}</td>
    <td align="right" valign="middle">${statusPill(ticket.status, ticket.statusLabel)}</td>
  </tr></table>
  <p class="m-text" style="margin:6px 0 0;${font(16, 22, 'font-weight:600;')}color:${LIGHT.text};word-break:break-word">${escapeHtml(ticket.subject)}</p>
</td></tr>` : '';

    const footerLinkHtml = footerLinks.map(link =>
        `<a class="m-muted" href="${escapeHtml(link.url)}" style="color:${LIGHT.muted};text-decoration:underline">${escapeHtml(link.label)}</a>`
    ).join('&nbsp;&nbsp;·&nbsp;&nbsp;');

    const html = `<!DOCTYPE html>
<html lang="de" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
<title>${escapeHtml(heading)}</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>
  v\\:* {behavior:url(#default#VML);display:inline-block}
  body,table,td,p,a,span,h1 {font-family:${MSO_FONT} !important}
  table {border-collapse:collapse}
</style>
<![endif]-->
<style>
  body{margin:0!important;padding:0!important;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}
  a{text-decoration-thickness:1px;text-underline-offset:2px}
  a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}
  u + .m-body a{color:inherit;text-decoration:none}
  @media (max-width:600px){.m-pad{padding-left:20px!important;padding-right:20px!important}.m-outer{padding-left:8px!important;padding-right:8px!important}}
</style>
<style>
  @media (prefers-color-scheme:dark){
${DARK_CSS}
  }
</style>
<style>
${OUTLOOK_DARK_CSS}
</style>
</head>
<body class="m-page m-body" bgcolor="${LIGHT.page}" style="margin:0;padding:0;background:${LIGHT.page};font-family:${FONT};color:${LIGHT.text};word-spacing:normal">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">${escapeHtml(preheader || heading)}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
<table ${T} class="m-page" width="100%" bgcolor="${LIGHT.page}" style="background:${LIGHT.page}">
<tr><td class="m-outer" align="center" style="padding:28px 12px 40px">
<!--[if mso]><table ${T} width="${WIDTH}" align="center"><tr><td><![endif]-->
<table ${T} width="100%" align="center" style="max-width:${WIDTH}px;margin:0 auto">
${replyable ? `<tr><td class="m-subtle" align="center" style="padding:0 4px 14px;${font(11, 16)}color:${LIGHT.subtle}">${escapeHtml(REPLY_MARKER)}</td></tr>` : ''}
<tr><td style="padding:0 4px 18px">
  <table ${T}><tr>
    <td width="18" valign="middle" style="width:18px">${logoHtml()}</td>
    <td class="m-text" valign="middle" style="padding-left:10px;${font(16, 22, 'font-weight:600;letter-spacing:-0.01em;')}color:${LIGHT.text}">${escapeHtml(appName)}</td>
  </tr></table>
</td></tr>
<tr><td>
  <table ${T} class="m-card" width="100%" bgcolor="${LIGHT.surface}" style="background:${LIGHT.surface};border:1px solid ${LIGHT.border};border-radius:16px;border-collapse:separate">
  ${ticketHead}
  <tr><td class="m-pad" style="padding:28px 28px 12px">
    <h1 class="m-text" style="margin:0 0 16px;${font(21, 28, 'font-weight:700;letter-spacing:-0.015em;')}color:${LIGHT.text}">${escapeHtml(heading)}</h1>
    ${paragraphs.map(p => paragraphHtml(p)).join('\n    ')}
    ${quote ? bubbleHtml(quote) : ''}
    ${attachments.length ? attachmentsHtml(attachments) : ''}
    ${button ? buttonHtml(button) : ''}
    ${after.map(p => paragraphHtml(p, { small: true })).join('\n    ')}
  </td></tr>
  </table>
</td></tr>
<tr><td class="m-subtle" align="center" style="padding:20px 8px 0;${font(12, 19)}color:${LIGHT.subtle}">
  ${escapeHtml(footer || appName)}${footerLinkHtml ? `<br>${footerLinkHtml}` : ''}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;

    return { text, html };
}

/* Entfernt den zitierten Teil einer Antwort-Mail (alles ab unserer
   Markierungszeile, "Am … schrieb …:", "On … wrote:", Outlook-Trenner und
   >-Zitatbloecke am Ende) — siehe lib/mail-inbound.js. */
function stripQuotedReply(text) {
    const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
    const cutPatterns = [
        /^\s*#+\s*Bitte oberhalb dieser Zeile antworten\s*#+\s*$/i,
        /^\s*Am .{4,200}schrieb.{0,200}:\s*$/i,
        /^\s*On .{4,200}wrote:\s*$/i,
        /^\s*-{2,}\s*(Original(nachricht| Message)|Ursprüngliche Nachricht)\s*-{2,}\s*$/i,
        /^\s*_{10,}\s*$/,
        /^\s*(Von|From):\s.+$/,
    ];
    let end = lines.length;
    for (let i = 0; i < lines.length; i += 1) {
        if (cutPatterns.some(pattern => pattern.test(lines[i]))) {
            end = i;
            break;
        }
    }
    const kept = lines.slice(0, end);
    while (kept.length && (/^\s*>/.test(kept[kept.length - 1]) || kept[kept.length - 1].trim() === '')) {
        kept.pop();
    }
    // Signatur-Trenner nach RFC 3676 ("-- ")
    const sigIndex = kept.findIndex(line => line === '-- ');
    return (sigIndex >= 0 ? kept.slice(0, sigIndex) : kept).join('\n').trim();
}

module.exports = { compose, escapeHtml, stripQuotedReply, REPLY_MARKER, LIGHT, DARK };
