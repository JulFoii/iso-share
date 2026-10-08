'use strict';

/*
 * Wissensdatenbank / FAQ (lib/kb-store.js):
 *
 *   /support                        Einstieg ins Support-Portal: Suche,
 *                                   veroeffentlichte Artikel nach Kategorie,
 *                                   Konto/Tickets
 *   /support/articles/:slug         ein Artikel (nur veroeffentlichte; ein
 *                                   eingeloggter Admin sieht auch Entwuerfe)
 *   /support/articles.json?q=       Vorschlaege fuers Ticketformular
 *                                   (public/js/kb-suggest.js)
 *   /admin/kb*                      Artikel anlegen, bearbeiten (mit
 *                                   Vorschau ohne Speichern), veroeffentlichen,
 *                                   loeschen — alles checkAuth-gated
 *
 * Artikeltext ist Markdown (lib/markdown.js), gerendert wird serverseitig;
 * der Renderer escaped alles, bevor er Tags erzeugt.
 */

const { renderMarkdown } = require('../markdown');
const { TITLE_MAX, BODY_MAX } = require('../kb-store');
const { safeKbSlug } = require('../safe-name');
const { textField } = require('./helpers');

function registerKbRoutes(ctx) {
    const {
        app, checkAuth, kbStore, configStore, auditLog, limiters, inboundEnabled, inboundNewTickets,
        supportAddress, isActiveAdmin,
    } = ctx;

    /* ------------------------------------------------------ oeffentlich -- */

    /* Artikel nach Kategorie gruppiert, in der Reihenfolge der Kategorien;
       Artikel ohne Kategorie zuletzt unter "Allgemein". */
    function groupByCategory(articles) {
        const order = configStore.listCategories().map(category => category.name);
        const groups = new Map();
        for (const article of articles) {
            const key = article.categoryName ?? 'Allgemein';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(article);
        }
        return [...groups.entries()]
            .sort(([a], [b]) => {
                const ia = order.indexOf(a) === -1 ? Infinity : order.indexOf(a);
                const ib = order.indexOf(b) === -1 ? Infinity : order.indexOf(b);
                return ia - ib || a.localeCompare(b, 'de');
            })
            .map(([name, items]) => ({ name, articles: items }));
    }

    app.get('/support', (req, res) => {
        const q = textField(req.query.q, 200);
        const articles = kbStore.list({ publishedOnly: true, q });
        res.render('support', {
            inboundEnabled,
            mailTicketAddress: inboundNewTickets ? supportAddress : null,
            q,
            groups: q ? [] : groupByCategory(articles),
            results: q ? articles : null,
        });
    });

    // Der alte Kontaktformular-Link (Footer, Lesezeichen) fuehrt hierher.
    app.get('/contact', (req, res) => res.redirect(301, '/support'));

    app.get('/support/articles.json', limiters.poll, (req, res) => {
        const q = textField(req.query.q, 200);
        const data = kbStore.suggest(q, 5).map(article => ({
            title: article.title, url: `/support/articles/${article.slug}`, excerpt: article.excerpt,
        }));
        res.json({ data });
    });

    app.get('/support/articles/:slug', (req, res) => {
        const slug = safeKbSlug(req.params.slug);
        const article = slug ? kbStore.getBySlug(slug) : null;
        const admin = isActiveAdmin(req);
        if (!article || (!article.published && !admin)) {
            return res.status(404).render('account/notice', {
                title: 'Artikel nicht gefunden',
                text: 'Diesen Hilfeartikel gibt es nicht (mehr).',
                action: { href: '/support', label: 'Zur Hilfe' }, variant: 'danger',
            });
        }
        // Aufrufe des Admins (Vorschau, Kontrolle) zaehlen nicht mit, ebenso
        // wenig das Live-Polling einer schon offenen Seite (live-regions.js)
        if (!admin && req.get('X-Idle-Background') !== '1') kbStore.recordView(article.id);
        const related = article.categoryId
            ? kbStore.list({ publishedOnly: true, categoryId: article.categoryId, limit: 6 })
                .filter(other => other.id !== article.id).slice(0, 5)
            : [];
        res.render('support-article', { article, html: renderMarkdown(article.body), related, isAdmin: admin });
    });

    /* ------------------------------------------------------------ Admin -- */

    function loadArticle(req, res, next) {
        const article = kbStore.get(req.params.id);
        if (!article) {
            if (req.method !== 'GET') return res.status(404).send('Artikel nicht gefunden');
            return res.status(404).render('account/notice', {
                title: 'Artikel nicht gefunden', text: 'Diesen Hilfeartikel gibt es nicht (mehr).',
                action: { href: '/admin/kb', label: 'Zu den Hilfeartikeln' }, variant: 'danger',
                loggedIn: true, page: 'admin-tickets',
            });
        }
        req.article = article;
        next();
    }

    app.get('/admin/kb', checkAuth, (req, res) => {
        const q = textField(req.query.q, 200);
        res.render('admin/kb', {
            articles: kbStore.list({ q }),
            q,
            done: String(req.query.done ?? ''),
        });
    });

    function renderEdit(res, { status = 200, article = null, values, error = null, preview = null }) {
        res.status(status).render('admin/kb-edit', {
            article,
            values,
            error,
            previewHtml: preview !== null ? renderMarkdown(preview) : null,
            categories: configStore.listCategories(),
            limits: { title: TITLE_MAX, body: BODY_MAX },
        });
    }

    function formValues(body) {
        return {
            title: String(body.title ?? ''),
            slug: String(body.slug ?? '').trim(),
            body: String(body.body ?? ''),
            // Nur eine existierende Kategorie — eine inzwischen geloeschte
            // (Formular noch offen) scheiterte sonst am Fremdschluessel (500).
            categoryId: configStore.getCategory(body.categoryId)?.id ?? null,
            published: body.published === '1',
        };
    }

    app.get('/admin/kb/new', checkAuth, (req, res) => {
        renderEdit(res, { values: { title: '', slug: '', body: '', categoryId: null, published: false } });
    });

    app.post('/admin/kb', checkAuth, (req, res) => {
        const values = formValues(req.body);
        if (req.body.action === 'preview') return renderEdit(res, { values, preview: values.body });
        const result = kbStore.create(values);
        if (result.error) return renderEdit(res, { status: 400, values, error: result.error });
        auditLog.log('kb_article_created', { ip: req.ip, article: result.article.slug, published: result.article.published });
        res.redirect(303, `/admin/kb/${result.article.id}?saved=1`);
    });

    app.get('/admin/kb/:id', checkAuth, loadArticle, (req, res) => {
        const { article } = req;
        renderEdit(res, {
            article,
            values: {
                title: article.title, slug: article.slug, body: article.body,
                categoryId: article.categoryId, published: article.published,
            },
            preview: req.query.saved === '1' ? article.body : null,
        });
    });

    app.post('/admin/kb/:id', checkAuth, loadArticle, (req, res) => {
        const values = formValues(req.body);
        if (req.body.action === 'preview') {
            return renderEdit(res, { article: req.article, values, preview: values.body });
        }
        const result = kbStore.update(req.article.id, values);
        if (result.error) return renderEdit(res, { status: 400, article: req.article, values, error: result.error });
        const changed = ['title', 'slug', 'categoryId', 'published'].filter(key => result.before[key] !== result.article[key]);
        if (result.before.body !== result.article.body) changed.push('body');
        auditLog.log('kb_article_updated', { ip: req.ip, article: result.article.slug, fields: changed });
        res.redirect(303, `/admin/kb/${result.article.id}?saved=1`);
    });

    app.post('/admin/kb/:id/publish', checkAuth, loadArticle, (req, res) => {
        const published = req.body.published === '1';
        kbStore.setPublished(req.article.id, published);
        auditLog.log(published ? 'kb_article_published' : 'kb_article_unpublished', { ip: req.ip, article: req.article.slug });
        res.redirect(303, `/admin/kb?done=${published ? 'published' : 'unpublished'}`);
    });

    app.post('/admin/kb/:id/delete', checkAuth, loadArticle, (req, res) => {
        kbStore.remove(req.article.id);
        auditLog.log('kb_article_deleted', { ip: req.ip, article: req.article.slug });
        res.redirect(303, '/admin/kb?done=deleted');
    });
}

module.exports = { registerKbRoutes };
