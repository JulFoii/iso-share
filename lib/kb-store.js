'use strict';

/*
 * Wissensdatenbank / FAQ (Tabelle `kb_articles`, siehe lib/db.js): kurze
 * Artikel im Markdown-Subset von lib/markdown.js, oeffentlich unter
 * /support/articles/:slug, gepflegt unter /admin/kb (lib/routes/kb.js).
 *
 * Der Slug entsteht einmal aus dem Titel und bleibt danach stabil — ein
 * spaeter umformulierter Titel soll keine schon verschickten Links (in
 * Ticket-Antworten, Mails) brechen. Der Admin kann ihn bewusst aendern.
 *
 * Suche per LIKE ueber Titel und Text: fuer die Handvoll Artikel einer
 * Single-Admin-Instanz genau richtig, ohne FTS-Tabelle und Trigger.
 * `views` zaehlt Aufrufe der Artikelseite (anonym, nur eine Zahl) fuer die
 * Reporting-Seite.
 */

const { plainExcerpt } = require('./markdown');

const TITLE_MAX = 150;
const BODY_MAX = 50000;
const SLUG_MAX = 80;

function slugify(title) {
    const base = String(title ?? '')
        .toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .normalize('NFKD').replace(/\p{M}/gu, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, SLUG_MAX)
        .replace(/-+$/g, '');
    return base || 'artikel';
}

function rowToArticle(row) {
    if (!row) return null;
    return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        body: row.body,
        excerpt: plainExcerpt(row.body),
        categoryId: row.category_id,
        categoryName: row.category_name ?? null,
        published: row.published === 1,
        position: row.position,
        views: row.views,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/* LIKE-Muster ohne die Platzhalterzeichen der Eingabe. */
function likeTerm(word) {
    return `%${String(word).replace(/[%_\\]/g, '')}%`;
}

/* Gezielte Suche: schon zwei Zeichen ("OS", "PC"). Vorschlaege beim Tippen
   erst ab drei, sonst traefe "ab" oder "es" fast jeden Artikel. */
function searchWords(q, minLength = 2) {
    return [...new Set(String(q ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= minLength))]
        .slice(0, 8);
}

function createKbStore({ db }) {
    if (!db) throw new Error('kb store braucht eine db');

    const SELECT = `
        SELECT a.*, c.name AS category_name
        FROM kb_articles a LEFT JOIN ticket_categories c ON c.id = a.category_id
    `;
    const getStmt = db.prepare(`${SELECT} WHERE a.id = ?`);
    const getBySlugStmt = db.prepare(`${SELECT} WHERE a.slug = ?`);
    const slugTakenStmt = db.prepare('SELECT id FROM kb_articles WHERE slug = ?');
    const insertStmt = db.prepare(`
        INSERT INTO kb_articles (slug, title, body, category_id, published, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM kb_articles), ?, ?)
    `);
    const updateStmt = db.prepare(`
        UPDATE kb_articles SET slug = ?, title = ?, body = ?, category_id = ?, published = ?, updated_at = ?
        WHERE id = ?
    `);
    const publishStmt = db.prepare('UPDATE kb_articles SET published = ?, updated_at = ? WHERE id = ?');
    const deleteStmt = db.prepare('DELETE FROM kb_articles WHERE id = ?');
    const viewStmt = db.prepare('UPDATE kb_articles SET views = views + 1 WHERE id = ?');

    function get(id) {
        const n = Number(id);
        return Number.isInteger(n) && n > 0 ? rowToArticle(getStmt.get(n)) : null;
    }

    function getBySlug(slug) {
        return rowToArticle(getBySlugStmt.get(String(slug ?? '')));
    }

    function uniqueSlug(wanted, exceptId = null) {
        const base = slugify(wanted);
        for (let n = 1; n < 1000; n += 1) {
            const candidate = n === 1 ? base : `${base.slice(0, SLUG_MAX - String(n).length - 1)}-${n}`;
            const taken = slugTakenStmt.get(candidate);
            if (!taken || taken.id === exceptId) return candidate;
        }
        return `${base.slice(0, 60)}-${Date.now()}`;
    }

    /* Gibt {error} oder die bereinigten Felder zurueck. */
    function validate(input) {
        const title = String(input?.title ?? '').replace(/\s+/g, ' ').trim();
        const body = String(input?.body ?? '').replace(/\r\n?/g, '\n').trim();
        if (!title) return { error: 'Bitte einen Titel angeben.' };
        if (title.length > TITLE_MAX) return { error: `Der Titel ist zu lang (höchstens ${TITLE_MAX} Zeichen).` };
        if (!body) return { error: 'Bitte einen Text angeben.' };
        if (body.length > BODY_MAX) return { error: `Der Text ist zu lang (höchstens ${BODY_MAX} Zeichen).` };
        const categoryId = Number(input?.categoryId) || null;
        return { title, body, categoryId, published: Boolean(input?.published) };
    }

    function create(input) {
        const clean = validate(input);
        if (clean.error) return clean;
        const at = Date.now();
        const { lastInsertRowid } = insertStmt.run(
            uniqueSlug(input?.slug || clean.title), clean.title, clean.body, clean.categoryId,
            clean.published ? 1 : 0, at, at
        );
        return { article: get(Number(lastInsertRowid)) };
    }

    function update(id, input) {
        const existing = get(id);
        if (!existing) return { error: 'Artikel nicht gefunden.' };
        const clean = validate(input);
        if (clean.error) return clean;
        const wanted = String(input?.slug ?? '').trim();
        const slug = wanted && wanted !== existing.slug ? uniqueSlug(wanted, existing.id) : existing.slug;
        updateStmt.run(slug, clean.title, clean.body, clean.categoryId, clean.published ? 1 : 0, Date.now(), existing.id);
        return { article: get(existing.id), before: existing };
    }

    function setPublished(id, published) {
        const existing = get(id);
        if (!existing) return null;
        publishStmt.run(published ? 1 : 0, Date.now(), existing.id);
        return get(existing.id);
    }

    function remove(id) {
        const existing = get(id);
        if (!existing) return null;
        deleteStmt.run(existing.id);
        return existing;
    }

    function recordView(id) {
        viewStmt.run(id);
    }

    /* Alle Artikel (Admin) bzw. nur veroeffentlichte, optional gefiltert.
       Mit q: jedes Wort muss in Titel oder Text vorkommen, Titeltreffer
       zuerst. */
    function list({ publishedOnly = false, q = '', categoryId = null, limit = 200 } = {}) {
        const where = [];
        const params = {};
        if (publishedOnly) where.push('a.published = 1');
        if (categoryId) {
            where.push('a.category_id = @categoryId');
            params.categoryId = Number(categoryId);
        }
        const words = searchWords(q);
        // Gesucht, aber nichts Verwertbares ("a", "!!"): keine Treffer statt
        // aller Artikel unter der Ueberschrift "Treffer fuer …".
        if (String(q ?? '').trim() && !words.length) return [];
        // Ohne Suchwoerter keine Trefferwertung — ein nacktes "ORDER BY 0"
        // laese SQLite als Spaltennummer.
        let order = 'a.position ASC, a.title ASC';
        if (words.length) {
            const hits = [];
            words.forEach((word, index) => {
                params[`w${index}`] = likeTerm(word);
                where.push(`(a.title LIKE @w${index} OR a.body LIKE @w${index})`);
                hits.push(`(a.title LIKE @w${index})`);
            });
            order = `(${hits.join(' + ')}) DESC, ${order}`;
        }
        const rows = db.prepare(`
            ${SELECT}
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY ${order}
            LIMIT ${Math.min(Math.max(1, Number(limit) || 200), 500)}
        `).all(params);
        return rows.map(rowToArticle);
    }

    /*
     * Vorschlaege beim Anlegen eines Tickets: wie list(), aber ein Wort
     * genuegt (ein Betreff ist kurz und meist unscharf) — sortiert nach der
     * Zahl der Treffer, Titeltreffer doppelt gewichtet.
     */
    function suggest(q, limit = 5) {
        const words = searchWords(q, 3);
        if (!words.length) return [];
        const params = {};
        const score = [];
        const any = [];
        words.forEach((word, index) => {
            params[`w${index}`] = likeTerm(word);
            score.push(`2 * (a.title LIKE @w${index}) + (a.body LIKE @w${index})`);
            any.push(`a.title LIKE @w${index} OR a.body LIKE @w${index}`);
        });
        return db.prepare(`
            ${SELECT}
            WHERE a.published = 1 AND (${any.join(' OR ')})
            ORDER BY ${score.join(' + ')} DESC, a.views DESC
            LIMIT ${Math.min(Math.max(1, Number(limit) || 5), 10)}
        `).all(params).map(rowToArticle);
    }

    function topViewed(limit = 10) {
        return db.prepare(`${SELECT} WHERE a.views > 0 ORDER BY a.views DESC LIMIT ?`).all(limit).map(rowToArticle);
    }

    return { get, getBySlug, create, update, setPublished, remove, recordView, list, suggest, topViewed };
}

module.exports = { createKbStore, slugify, TITLE_MAX, BODY_MAX, SLUG_MAX };
