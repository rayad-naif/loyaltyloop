'use strict';

const store = require('./store');
const { K } = store;
const { verifySession } = require('./crypto');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Tiny fixed-window rate limiter (per server instance; good enough as a brake, not a firewall). */
function rateLimit({ windowMs = 60000, max = 60, keyFn } = {}) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip;
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) {
      h = { n: 0, reset: now + windowMs };
      hits.set(key, h);
    }
    if (++h.n > max) {
      res.setHeader('Retry-After', Math.ceil((h.reset - now) / 1000));
      return res.status(429).json({ success: false, error: 'rate_limited', message: 'Too many requests. Please slow down.' });
    }
    next();
  };
}

/** Requires a valid LoyaltyLoop session token; scopes every request to ONE location. */
const requireSession = wrap(async (req, res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const claims = verifySession(token);
  if (!claims || !claims.loc) {
    return res.status(401).json({ success: false, error: 'unauthorized', message: 'Session expired. Reopen the app from your CRM.' });
  }
  // The install record disappears when the app is uninstalled -> sessions die with it.
  if (!(await store.get(K.install(claims.loc)))) {
    return res.status(403).json({ success: false, error: 'not_installed', message: 'LoyaltyLoop is not installed for this location.' });
  }
  req.session = claims;
  req.locationId = claims.loc;
  next();
});

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Minimal branded HTML message page (no inline scripts -> works under our strict CSP). */
function messagePage({ title, heading, body, tone = 'ok', actions = '' }) {
  const icon = tone === 'ok' ? '✓' : '!';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · LoyaltyLoop</title><link rel="stylesheet" href="/assets/site.css"></head>
<body class="center-page"><main class="msg-card"><div class="msg-icon ${tone}">${icon}</div>
<h1>${esc(heading)}</h1><div class="msg-body">${body}</div>${actions}
<p class="muted small">LoyaltyLoop by IR Official · <a href="/support">Support</a></p></main></body></html>`;
}

function errorHandler(err, req, res, _next) {
  const status = err.status || err.response?.status || 500;
  if (status >= 500) console.error(`[error] ${req.method} ${req.path}:`, err.ghlMessage || err.message);
  const wantsJson = req.path.startsWith('/api') || req.path.startsWith('/sso') || req.path.startsWith('/webhook');
  const safe = status >= 500 ? 'Something went wrong on our side. Please try again.' : err.message;
  if (wantsJson) return res.status(status).json({ success: false, error: err.code || 'error', message: safe });
  res.status(status).send(messagePage({ title: 'Error', heading: 'Something went wrong', body: `<p>${esc(safe)}</p>`, tone: 'err' }));
}

module.exports = { wrap, rateLimit, requireSession, errorHandler, messagePage, esc };
