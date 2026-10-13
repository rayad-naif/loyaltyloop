'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const store = require('./store');
const { usingDerivedKey } = require('./crypto');
const { errorHandler, messagePage } = require('./middleware');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const VIEWS = path.join(ROOT, 'views');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Keep the raw body: webhook signatures are computed over the exact bytes HighLevel sent.
app.use(
  express.json({
    limit: '512kb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    }
  })
);

const CSP = (frameAncestors) =>
  [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`
  ].join('; ');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', CSP("'self'"));
  next();
});

// ---------------------------------------------------------------- health
function warnings() {
  const w = [];
  const g = config.ghl;
  if (!g.clientId || !g.clientSecret) w.push('GHL_CLIENT_ID / GHL_CLIENT_SECRET are not set - OAuth install will fail.');
  if (!g.sharedSecret) w.push('GHL_SHARED_SECRET is not set - the in-CRM dashboard cannot sign users in (SSO).');
  if (!store.isPersistent()) w.push('No persistent storage: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. Data is lost on restart.');
  if (!config.security.tokenEncKey) w.push('TOKEN_ENC_KEY is not set - tokens are encrypted with a key derived from GHL_CLIENT_SECRET. Set a dedicated key.');
  if (!config.security.sessionSecret) w.push('SESSION_SECRET is not set - using a derived secret. Set a dedicated value.');
  if (!config.webhook.verify) w.push('WEBHOOK_VERIFY=off - webhook signatures are NOT being verified.');
  if (config.isProd && /localhost/.test(config.baseUrl)) w.push('APP_BASE_URL is not set - redirect/webhook URLs will point at localhost.');
  return w;
}

app.get('/health', (req, res) => {
  const w = warnings();
  res.json({
    status: 'ok',
    app: config.app.name,
    time: new Date().toISOString(),
    storage: { driver: store.driver.name, persistent: store.isPersistent() },
    configured: {
      oauth: !!(config.ghl.clientId && config.ghl.clientSecret),
      sso: !!config.ghl.sharedSecret,
      webhookVerification: config.webhook.verify,
      dedicatedEncryptionKey: !usingDerivedKey()
    },
    callbackUrl: config.ghl.redirectUri,
    webhookUrl: `${config.baseUrl}/webhook/leadconnector`,
    warnings: w.length ? w : undefined
  });
});

// ---------------------------------------------------------------- dynamic routes
app.use(require('./routes/oauth'));
app.use(require('./routes/sso'));
app.use(require('./routes/webhooks'));
app.use('/api', require('./routes/api'));

// The embedded dashboard. Must be framable by HighLevel (incl. white-label domains), so it gets its own CSP.
app.get('/app', (req, res) => {
  const file = path.join(VIEWS, 'app.html');
  if (!fs.existsSync(file)) return res.status(500).send('views/app.html is missing');
  res.setHeader('Content-Security-Policy', CSP('*'));
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(file);
});

// ---------------------------------------------------------------- static pages (Render / AWS / local; Vercel serves /public itself)
app.use(
  express.static(PUBLIC, {
    extensions: ['html'],
    maxAge: config.isProd ? '1h' : 0,
    setHeaders: (res, p) => {
      if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    }
  })
);
app.get('/home', (req, res) => res.redirect(301, '/'));

app.use((req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/webhook') || req.path.startsWith('/sso')) {
    return res.status(404).json({ success: false, error: 'not_found' });
  }
  const f = path.join(PUBLIC, '404.html');
  if (fs.existsSync(f)) return res.status(404).sendFile(f);
  res.status(404).send(messagePage({ title: 'Not found', heading: 'Page not found', body: '<p>That page does not exist.</p>', tone: 'err' }));
});

app.use(errorHandler);

module.exports = app;
module.exports.warnings = warnings;
