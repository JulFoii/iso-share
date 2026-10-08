'use strict';

/*
 * Kundenkonten: Registrierung mit E-Mail-Bestaetigung, Login/Logout,
 * Passwort vergessen/zuruecksetzen, Profil- und Benachrichtigungs-
 * einstellungen, E-Mail-Wechsel, Datenexport und Kontoloeschung (DSGVO).
 *
 * Getrennte Vertrauensgrenze zum Admin: ein Kunde bekommt nur
 * req.session.customerId, nie req.session.loggedIn — checkAuth (Admin)
 * und checkCustomer (hier) pruefen jeweils nur ihr eigenes Feld. Beide
 * Logins vergeben die Session-ID neu (regenerate), ein Kunden-Login im
 * selben Browser beendet also eine offene Admin-Sitzung und umgekehrt.
 *
 * Anti-Enumeration: Registrierung, "Passwort vergessen" und "Bestaetigung
 * erneut senden" antworten immer gleich, egal ob es ein Konto zu der Adresse
 * gibt — die Unterscheidung erfaehrt nur, wer Zugriff auf das Postfach hat.
 * Der Login rechnet auch fuer unbekannte Adressen eine volle scrypt-Runde
 * (siehe authenticate() in lib/customer-store.js).
 */

const {
    safeEmail, safeCustomerToken, safeDisplayName,
} = require('../safe-name');
const {
    checkPasswordStrength, safeNextPath, textField,
} = require('./helpers');

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

/*
 * Getrennt von registerAccountRoutes(), weil loadCustomer vor *allen*
 * Routen haengen muss (server.js ruft das direkt nach der CSRF-Middleware
 * auf) — sonst wuesste die Navigation auf /, /privacy usw. nichts vom
 * angemeldeten Kunden.
 */
function createCustomerAuth({ customerStore, ticketStore }) {
    /*
     * Laedt fuer jede Anfrage mit Kunden-Session das Konto frisch aus der DB
     * — ein inzwischen gesperrtes oder geloeschtes Konto verliert damit
     * sofort den Zugriff, nicht erst beim naechsten Login.
     */
    function loadCustomer(req, res, next) {
        res.locals.loggedIn = Boolean(req.session && req.session.loggedIn);
        res.locals.currentCustomer = null;
        res.locals.customerUnread = 0;
        res.locals.adminTicketBadge = res.locals.loggedIn ? ticketStore.countViews().unread : 0;
        const id = req.session && req.session.customerId;
        if (!id) return next();
        const customer = customerStore.getCustomer(id);
        if (!customer || customer.disabled) {
            delete req.session.customerId;
            return next();
        }
        req.customer = customer;
        res.locals.currentCustomer = customer;
        res.locals.customerUnread = ticketStore.countUnreadForCustomer(customer.id);
        next();
    }

    function checkCustomer(req, res, next) {
        if (req.customer) return next();
        if (req.accepts(['html', 'json']) === 'json') {
            return res.status(401).json({ error: 'Nicht angemeldet.' });
        }
        const nextPath = req.method === 'GET' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
        res.redirect(`/account/login${nextPath}`);
    }

    return { loadCustomer, checkCustomer };
}

function registerAccountRoutes(ctx) {
    const {
        app, customerStore, ticketStore, attachmentStore, ticketMail, outbox, sessionStore, auditLog, log,
        limiters, mailEnabled,
    } = ctx;

    function notice(res, { title, text, status = 200, action = null, variant = 'info' }) {
        return res.status(status).render('account/notice', { title, text, action, variant });
    }

    function startSession(req, res, next, customer, target) {
        req.session.regenerate(err => {
            if (err) return next(err);
            req.session.customerId = customer.id;
            customerStore.recordLogin(customer.id);
            res.redirect(target);
        });
    }

    /* Nach bestaetigter Adresse: evtl. vorhandene Tickets ohne Konto
       (Prototyp-Import) mit genau dieser Adresse uebernehmen. */
    function claimTickets(customer) {
        const claimed = ticketStore.claimTicketsByEmail(customer);
        if (claimed > 0) auditLog.log('tickets_claimed', { customerId: customer.id, count: claimed });
    }

    const { checkCustomer } = ctx;

    /* --------------------------------------------------- Registrierung -- */

    app.get('/account', (req, res) => {
        res.redirect(req.customer ? '/account/tickets' : '/account/login');
    });

    app.get('/account/register', (req, res) => {
        if (req.customer) return res.redirect('/account/tickets');
        res.render('account/register', { error: null, values: {} });
    });

    app.post('/account/register', limiters.accountGlobal, limiters.accountPerIp, async (req, res, next) => {
        const values = { name: textField(req.body.name, 80), email: textField(req.body.email, 254) };
        const renderError = error => res.status(400).render('account/register', { error, values });

        // Honeypot wie frueher beim Kontaktformular: stiller Fake-Erfolg.
        if (String(req.body.website ?? '').length > 0) {
            auditLog.log('register_honeypot_triggered', { ip: req.ip });
            return renderCheckInbox(res);
        }

        const name = safeDisplayName(req.body.name);
        const email = safeEmail(req.body.email);
        if (!name) return renderError('Bitte gib deinen Namen an (max. 80 Zeichen).');
        if (!email) return renderError('Bitte gib eine gültige E-Mail-Adresse an.');
        const weak = checkPasswordStrength(req.body.password, { email, name });
        if (weak) return renderError(weak);
        if (req.body.password !== req.body.passwordConfirm) {
            return renderError('Die Passwörter stimmen nicht überein.');
        }
        if (req.body.privacy !== '1') {
            return renderError('Bitte bestätige, dass du die Datenschutzerklärung gelesen hast.');
        }

        try {
            const existing = customerStore.findByEmail(email);
            if (existing) {
                // Eine scrypt-Runde wie beim echten Anlegen, damit die
                // Antwortzeit nicht verraet, dass die Adresse schon existiert.
                await customerStore.authenticate('', '');
                if (!existing.emailVerified && !existing.disabled) {
                    // Noch nie bestaetigt (z. B. erste Mail verloren): ein
                    // "du hast schon ein Konto, melde dich an" fuehrte in eine
                    // Sackgasse, weil die Anmeldung genau daran scheitert —
                    // also einfach einen frischen Bestaetigungslink.
                    ticketMail.verifyEmail(existing, customerStore.issueToken(existing.id, 'verify', { ttlMs: VERIFY_TTL_MS }));
                } else if (!existing.disabled) {
                    ticketMail.accountExists(existing);
                }
                auditLog.log('register_existing_email', { ip: req.ip });
                return renderCheckInbox(res);
            }
            let customer;
            try {
                customer = await customerStore.createCustomer({ email, name, password: req.body.password });
            } catch (err) {
                if (err.code === 'email_taken') return renderCheckInbox(res);
                throw err;
            }
            const token = customerStore.issueToken(customer.id, 'verify', { ttlMs: VERIFY_TTL_MS });
            ticketMail.verifyEmail(customer, token);
            auditLog.log('customer_registered', { ip: req.ip, customerId: customer.id });
            renderCheckInbox(res);
        } catch (err) {
            next(err);
        }
    });

    function renderCheckInbox(res) {
        return notice(res, {
            title: 'Fast geschafft',
            variant: 'success',
            text: mailEnabled
                ? 'Wir haben dir eine E-Mail mit einem Bestätigungslink geschickt. Sobald du deine Adresse ' +
                  'bestätigt hast, kannst du dich anmelden. Keine Mail bekommen? Schau im Spam-Ordner nach ' +
                  'oder fordere sie auf der Anmeldeseite erneut an.'
                : 'Dein Konto wurde angelegt. Da auf diesem Server kein Mailversand eingerichtet ist, muss der ' +
                  'Betreiber deine E-Mail-Adresse von Hand freischalten — danach kannst du dich anmelden.',
            action: { href: '/account/login', label: 'Zur Anmeldung' },
        });
    }

    app.get('/account/verify', (req, res) => {
        const token = safeCustomerToken(req.query.token);
        const result = token ? customerStore.consumeToken(token, 'verify') : null;
        if (!result) {
            return notice(res, {
                status: 400, variant: 'danger', title: 'Link ungültig',
                text: 'Dieser Bestätigungslink ist ungültig oder abgelaufen. Fordere auf der Anmeldeseite einen neuen an.',
                action: { href: '/account/login', label: 'Zur Anmeldung' },
            });
        }
        customerStore.markVerified(result.customer.id);
        claimTickets(result.customer);
        auditLog.log('customer_verified', { customerId: result.customer.id });
        notice(res, {
            variant: 'success', title: 'E-Mail-Adresse bestätigt',
            text: 'Danke! Dein Konto ist jetzt aktiv — du kannst dich anmelden und Tickets anlegen.',
            action: { href: '/account/login', label: 'Jetzt anmelden' },
        });
    });

    app.post('/account/resend-verification', limiters.accountGlobal, limiters.accountPerIp, (req, res) => {
        const email = safeEmail(req.body.email);
        const customer = email ? customerStore.findByEmail(email) : null;
        if (customer && !customer.emailVerified && !customer.disabled) {
            const token = customerStore.issueToken(customer.id, 'verify', { ttlMs: VERIFY_TTL_MS });
            ticketMail.verifyEmail(customer, token);
        }
        notice(res, {
            title: 'Bestätigungslink angefordert',
            text: 'Falls zu dieser Adresse ein noch nicht bestätigtes Konto existiert, ist ein neuer Link unterwegs.',
            action: { href: '/account/login', label: 'Zur Anmeldung' },
        });
    });

    /* ----------------------------------------------------------- Login -- */

    app.get('/account/login', (req, res) => {
        if (req.customer) return res.redirect(safeNextPath(req.query.next, '/account/tickets'));
        res.render('account/login', {
            error: null, unverifiedEmail: null, email: '', next: safeNextPath(req.query.next, ''),
            reset: req.query.reset === '1',
        });
    });

    app.post('/account/login', limiters.customerLoginGlobal, limiters.customerLoginPerIp, async (req, res, next) => {
        const email = textField(req.body.email, 254);
        const target = safeNextPath(req.body.next, '/account/tickets');
        const fail = (error, extra = {}) => res.status(401).render('account/login', {
            error, unverifiedEmail: null, email, next: safeNextPath(req.body.next, ''), reset: false, ...extra,
        });
        try {
            const customer = await customerStore.authenticate(email, req.body.password);
            if (!customer) {
                auditLog.log('customer_login_failed', { ip: req.ip });
                return fail('E-Mail-Adresse oder Passwort falsch.');
            }
            if (customer.disabled) {
                auditLog.log('customer_login_disabled', { ip: req.ip, customerId: customer.id });
                return fail('Dieses Konto wurde gesperrt. Bitte wende dich an den Betreiber.');
            }
            if (!customer.emailVerified) {
                return fail('Bitte bestätige zuerst deine E-Mail-Adresse über den Link in unserer Mail.', {
                    unverifiedEmail: customer.email,
                });
            }
            auditLog.log('customer_login', { ip: req.ip, customerId: customer.id });
            startSession(req, res, next, customer, target);
        } catch (err) {
            next(err);
        }
    });

    app.get('/account/logout', (req, res) => {
        if (!req.session) return res.redirect('/');
        req.session.destroy(() => {
            res.clearCookie('iso.sid');
            res.redirect('/support');
        });
    });

    /* --------------------------------------------- Passwort vergessen -- */

    app.get('/account/forgot', (req, res) => {
        res.render('account/forgot', { error: null });
    });

    app.post('/account/forgot', limiters.accountGlobal, limiters.accountPerIp, (req, res) => {
        const email = safeEmail(req.body.email);
        if (!email) return res.status(400).render('account/forgot', { error: 'Bitte gib eine gültige E-Mail-Adresse an.' });
        const customer = customerStore.findByEmail(email);
        if (customer && !customer.disabled) {
            const token = customerStore.issueToken(customer.id, 'reset', { ttlMs: RESET_TTL_MS });
            ticketMail.passwordReset(customer, token);
            auditLog.log('customer_password_reset_requested', { ip: req.ip, customerId: customer.id });
        }
        notice(res, {
            title: 'Prüfe dein Postfach',
            text: 'Falls zu dieser Adresse ein Konto existiert, haben wir dir einen Link zum Zurücksetzen des ' +
                  'Passworts geschickt. Er ist eine Stunde gültig.',
            action: { href: '/account/login', label: 'Zur Anmeldung' },
        });
    });

    function invalidResetLink(res) {
        return notice(res, {
            status: 400, variant: 'danger', title: 'Link ungültig',
            text: 'Dieser Link zum Zurücksetzen ist ungültig oder abgelaufen. Fordere einfach einen neuen an.',
            action: { href: '/account/forgot', label: 'Neuen Link anfordern' },
        });
    }

    app.get('/account/reset', (req, res) => {
        const token = safeCustomerToken(req.query.token);
        const customer = token ? customerStore.peekToken(token, 'reset') : null;
        if (!customer) return invalidResetLink(res);
        res.render('account/reset', { token, error: null });
    });

    app.post('/account/reset', limiters.accountGlobal, limiters.accountPerIp, async (req, res, next) => {
        const token = safeCustomerToken(req.body.token);
        const customer = token ? customerStore.peekToken(token, 'reset') : null;
        if (!customer) return invalidResetLink(res);
        const weak = checkPasswordStrength(req.body.password, customer);
        const error = weak ?? (req.body.password !== req.body.passwordConfirm ? 'Die Passwörter stimmen nicht überein.' : null);
        if (error) return res.status(400).render('account/reset', { token, error });
        try {
            if (!customerStore.consumeToken(token, 'reset')) return invalidResetLink(res);
            await customerStore.setPassword(customer.id, req.body.password);
            // Wer den Reset-Link hat, hat das Postfach — das bestaetigt die
            // Adresse gleich mit.
            if (!customer.emailVerified) {
                customerStore.markVerified(customer.id);
                claimTickets(customer);
            }
            sessionStore.destroyForCustomer(customer.id);
            ticketMail.passwordChanged(customer);
            auditLog.log('customer_password_reset', { ip: req.ip, customerId: customer.id });
            res.redirect('/account/login?reset=1');
        } catch (err) {
            next(err);
        }
    });

    /* ---------------------------------------------------- Einstellungen -- */

    function renderSettings(req, res, { status = 200, errors = {}, success = null } = {}) {
        res.status(status).render('account/settings', {
            customer: req.customer, errors, success, mailEnabled,
            pendingEmail: req.query.email === 'sent',
        });
    }

    app.get('/account/settings', checkCustomer, (req, res) => {
        const flash = {
            profile: 'Profil gespeichert.', password: 'Passwort geändert.', notifications: 'Benachrichtigungen gespeichert.',
            email: 'Neue E-Mail-Adresse bestätigt.',
        }[req.query.saved];
        renderSettings(req, res, { success: flash ?? null });
    });

    app.post('/account/settings/profile', checkCustomer, (req, res) => {
        const name = safeDisplayName(req.body.name);
        if (!name) return renderSettings(req, res, { status: 400, errors: { profile: 'Bitte gib einen Namen an (max. 80 Zeichen).' } });
        customerStore.setName(req.customer.id, name);
        ticketStore.syncRequester({ ...req.customer, name });
        res.redirect('/account/settings?saved=profile');
    });

    app.post('/account/settings/password', checkCustomer, limiters.customerLoginGlobal, limiters.customerLoginPerIp,
        async (req, res, next) => {
            try {
                if (!(await customerStore.verifyPassword(req.customer.id, req.body.currentPassword))) {
                    return renderSettings(req, res, { status: 401, errors: { password: 'Das aktuelle Passwort ist falsch.' } });
                }
                const weak = checkPasswordStrength(req.body.password, req.customer);
                const error = weak ?? (req.body.password !== req.body.passwordConfirm ? 'Die Passwörter stimmen nicht überein.' : null);
                if (error) return renderSettings(req, res, { status: 400, errors: { password: error } });
                await customerStore.setPassword(req.customer.id, req.body.password);
                sessionStore.destroyForCustomer(req.customer.id, req.sessionID);
                ticketMail.passwordChanged(req.customer);
                auditLog.log('customer_password_changed', { ip: req.ip, customerId: req.customer.id });
                res.redirect('/account/settings?saved=password');
            } catch (err) {
                next(err);
            }
        });

    app.post('/account/settings/email', checkCustomer, limiters.customerLoginGlobal, limiters.customerLoginPerIp,
        async (req, res, next) => {
            try {
                const email = safeEmail(req.body.email);
                if (!email) return renderSettings(req, res, { status: 400, errors: { email: 'Bitte gib eine gültige E-Mail-Adresse an.' } });
                if (!(await customerStore.verifyPassword(req.customer.id, req.body.currentPassword))) {
                    return renderSettings(req, res, { status: 401, errors: { email: 'Das Passwort ist falsch.' } });
                }
                if (email.toLowerCase() === req.customer.email) {
                    return renderSettings(req, res, { status: 400, errors: { email: 'Das ist bereits deine aktuelle Adresse.' } });
                }
                // Auch hier keine Enumeration: ist die Adresse schon vergeben,
                // geht einfach keine Mail raus, die Antwort ist identisch.
                if (!customerStore.findByEmail(email)) {
                    const token = customerStore.issueToken(req.customer.id, 'email_change', {
                        ttlMs: VERIFY_TTL_MS, payload: email.toLowerCase(),
                    });
                    ticketMail.emailChange(req.customer, email, token);
                }
                auditLog.log('customer_email_change_requested', { ip: req.ip, customerId: req.customer.id });
                res.redirect('/account/settings?email=sent');
            } catch (err) {
                next(err);
            }
        });

    app.get('/account/confirm-email', (req, res) => {
        const token = safeCustomerToken(req.query.token);
        const result = token ? customerStore.consumeToken(token, 'email_change') : null;
        if (!result || !result.payload || !customerStore.setEmail(result.customer.id, result.payload)) {
            return notice(res, {
                status: 400, variant: 'danger', title: 'Link ungültig',
                text: 'Dieser Link ist ungültig, abgelaufen, oder die Adresse wird inzwischen von einem anderen Konto verwendet.',
                action: { href: '/account/settings', label: 'Zu den Einstellungen' },
            });
        }
        const updated = customerStore.getCustomer(result.customer.id);
        ticketStore.syncRequester(updated);
        auditLog.log('customer_email_changed', { customerId: updated.id });
        res.redirect(req.customer ? '/account/settings?saved=email' : '/account/login');
    });

    app.post('/account/settings/notifications', checkCustomer, (req, res) => {
        customerStore.setNotify(req.customer.id, {
            replies: req.body.replies === '1',
            status: req.body.status === '1',
            reminders: req.body.reminders === '1',
        });
        res.redirect('/account/settings?saved=notifications');
    });

    /* ----------------------------------------------------------- DSGVO -- */

    app.get('/account/export', checkCustomer, (req, res) => {
        const { customer } = req;
        const data = {
            exportedAt: new Date().toISOString(),
            account: {
                name: customer.name,
                email: customer.email,
                createdAt: new Date(customer.createdAt).toISOString(),
                emailVerifiedAt: customer.emailVerifiedAt ? new Date(customer.emailVerifiedAt).toISOString() : null,
                notifications: customer.notify,
            },
            tickets: ticketStore.exportForCustomer(customer.id),
        };
        auditLog.log('customer_export', { customerId: customer.id });
        res.attachment('iso-share-support-export.json');
        res.type('application/json').send(JSON.stringify(data, null, 2));
    });

    app.post('/account/delete', checkCustomer, limiters.customerLoginGlobal, limiters.customerLoginPerIp,
        async (req, res, next) => {
            try {
                if (String(req.body.confirm ?? '').trim().toUpperCase() !== 'LÖSCHEN') {
                    return renderSettings(req, res, { status: 400, errors: { delete: 'Bitte tippe LÖSCHEN zur Bestätigung.' } });
                }
                if (!(await customerStore.verifyPassword(req.customer.id, req.body.currentPassword))) {
                    return renderSettings(req, res, { status: 401, errors: { delete: 'Das Passwort ist falsch.' } });
                }
                await deleteCustomerCompletely(req.customer);
                auditLog.log('customer_deleted', { ip: req.ip, customerId: req.customer.id, by: 'customer' });
                req.session.destroy(() => {
                    res.clearCookie('iso.sid');
                    notice(res, {
                        variant: 'success', title: 'Konto gelöscht',
                        text: 'Dein Konto und alle zugehörigen Tickets, Nachrichten und Anhänge wurden gelöscht.',
                        action: { href: '/', label: 'Zur Startseite' },
                    });
                });
            } catch (err) {
                next(err);
            }
        });

    /* Auch von /admin/customers/:id/delete genutzt. */
    async function deleteCustomerCompletely(customer) {
        const attachmentIds = ticketStore.deleteTicketsOfCustomer(customer.id);
        await attachmentStore.removeFiles(attachmentIds);
        customerStore.deleteCustomer(customer.id);
        sessionStore.destroyForCustomer(customer.id);
        outbox.forgetAddress(customer.email);
        ticketMail.accountDeleted(customer);
    }

    ctx.deleteCustomerCompletely = deleteCustomerCompletely;
    ctx.claimTickets = claimTickets;
    ctx.verifyTtlMs = VERIFY_TTL_MS;

    if (!mailEnabled) {
        log.log?.('ℹ️  Kundenkonten ohne Mailversand: neue Konten unter /admin/customers freischalten.');
    }
}

module.exports = { registerAccountRoutes, createCustomerAuth };
