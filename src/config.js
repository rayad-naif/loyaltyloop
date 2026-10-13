'use strict';

const env = process.env;
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const pem = (v) => (v ? String(v).replace(/\\n/g, '\n') : '');

const port = int(env.PORT, 3000);
const isProd = env.NODE_ENV === 'production' || !!env.VERCEL || !!env.RENDER;
const vercelHost = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL;
const baseUrl = (
  env.APP_BASE_URL ||
  env.RENDER_EXTERNAL_URL ||
  (vercelHost ? `https://${vercelHost}` : `http://localhost:${port}`)
).replace(/\/+$/, '');

// Scopes your Marketplace app must enable (App -> Advanced Settings -> Auth -> Scopes).
const DEFAULT_SCOPES = [
  'contacts.readonly',
  'contacts.write',
  'locations.readonly',
  'locations/customFields.readonly',
  'locations/customFields.write',
  'invoices.readonly',
  'calendars/events.readonly',
  'oauth.readonly',
  'oauth.write'
].join(' ');

// Public key published by HighLevel for X-GHL-Signature (Ed25519).
// Source: https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide
const GHL_ED25519_PUBLIC_KEY =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=\n-----END PUBLIC KEY-----';

module.exports = {
  env: env.NODE_ENV || 'development',
  isProd,
  port,
  baseUrl,
  app: { name: 'LoyaltyLoop' },
  company: { name: 'IR Official', email: 'idylle_radieuse@outlook.com' },

  ghl: {
    apiBase: 'https://services.leadconnectorhq.com',
    oauthVersion: 'v3',
    apiVersion: env.GHL_API_VERSION || '2021-07-28',
    clientId: env.GHL_CLIENT_ID || '',
    clientSecret: env.GHL_CLIENT_SECRET || '',
    redirectUri: env.GHL_REDIRECT_URI || `${baseUrl}/oauth/callback/lc`,
    sharedSecret: env.GHL_SHARED_SECRET || '',
    appId: env.GHL_APP_ID || '',
    versionId: env.GHL_VERSION_ID || '',
    installUrl: env.GHL_INSTALL_URL || '',
    scopes: env.GHL_SCOPES || DEFAULT_SCOPES
  },

  webhook: {
    verify: env.WEBHOOK_VERIFY !== 'off',
    ed25519Pem: pem(env.GHL_WEBHOOK_ED25519_PUBLIC_KEY) || GHL_ED25519_PUBLIC_KEY,
    // Legacy X-WH-Signature (RSA-SHA256, deprecated by HighLevel Sep 1 2026). Optional.
    rsaPem: pem(env.GHL_WEBHOOK_RSA_PUBLIC_KEY)
  },

  security: {
    tokenEncKey: env.TOKEN_ENC_KEY || '',
    sessionSecret: env.SESSION_SECRET || '',
    sessionTtlSec: int(env.SESSION_TTL_SECONDS, 8 * 60 * 60),
    // Only for local development: allows /app?dev=<locationId> without HighLevel SSO (needs ALLOW_DEV_LOCATION=true).
    devBypass: !isProd && env.ALLOW_DEV_LOCATION === 'true'
  },

  storage: {
    // KV_REST_API_* are what Vercel's Upstash/KV integration injects automatically.
    upstashUrl: (env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '').replace(/\/+$/, ''),
    upstashToken: env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '',
    dataDir: env.DATA_DIR || '.data'
  },

  limits: {
    maxRules: 100,
    maxPointsPerAdjust: 1000000,
    activityKeep: 300
  }
};
