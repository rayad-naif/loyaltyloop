'use strict';

const crypto = require('crypto');
const config = require('./config');

// ---------- helpers ----------
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(String(s), 'base64url');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---------- encryption at rest (AES-256-GCM) ----------
let _key = null;
let _keyDerived = false;

function encKey() {
  if (_key) return _key;
  const raw = config.security.tokenEncKey;
  if (raw) {
    _key = /^[0-9a-fA-F]{64}$/.test(raw)
      ? Buffer.from(raw, 'hex')
      : crypto.createHash('sha256').update(raw).digest();
  } else {
    // Fallback so the app works with zero extra config. Set TOKEN_ENC_KEY in production.
    const seed = config.ghl.clientSecret || 'loyaltyloop-dev-only-key';
    _key = crypto.createHash('sha256').update('ll-enc:' + seed).digest();
    _keyDerived = true;
  }
  return _key;
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', b64url(iv), b64url(cipher.getAuthTag()), b64url(ct)].join('.');
}

function decrypt(token) {
  const [v, iv, tag, ct] = String(token).split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Invalid encrypted value');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), fromB64url(iv));
  d.setAuthTag(fromB64url(tag));
  return Buffer.concat([d.update(fromB64url(ct)), d.final()]).toString('utf8');
}

const usingDerivedKey = () => {
  encKey();
  return _keyDerived;
};

// ---------- HighLevel SSO payload (CryptoJS / OpenSSL "Salted__" AES-256-CBC) ----------
function evpBytesToKey(password, salt, keyLen = 32, ivLen = 16) {
  let d = Buffer.alloc(0);
  let out = Buffer.alloc(0);
  while (out.length < keyLen + ivLen) {
    d = crypto.createHash('md5').update(Buffer.concat([d, password, salt])).digest();
    out = Buffer.concat([out, d]);
  }
  return { key: out.subarray(0, keyLen), iv: out.subarray(keyLen, keyLen + ivLen) };
}

function ssoDecrypt(encryptedBase64, sharedSecret) {
  if (!sharedSecret) throw new Error('Shared secret not configured');
  const raw = Buffer.from(String(encryptedBase64), 'base64');
  if (raw.length < 32 || raw.subarray(0, 8).toString('utf8') !== 'Salted__') {
    throw new Error("Invalid SSO payload: missing 'Salted__' header");
  }
  const salt = raw.subarray(8, 16);
  const { key, iv } = evpBytesToKey(Buffer.from(sharedSecret, 'utf8'), salt);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const plain = Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// Test helper: produce a payload exactly like CryptoJS.AES.encrypt(json, secret).
function ssoEncryptForTests(obj, sharedSecret) {
  const salt = crypto.randomBytes(8);
  const { key, iv } = evpBytesToKey(Buffer.from(sharedSecret, 'utf8'), salt);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('Salted__'), salt, ct]).toString('base64');
}

// ---------- signed session tokens (HMAC-SHA256) ----------
function sessionSecret() {
  if (config.security.sessionSecret) return config.security.sessionSecret;
  // Derived so the app works with zero extra config. Set SESSION_SECRET in production.
  if (config.isProd && !config.ghl.clientSecret && !config.ghl.sharedSecret) {
    throw new Error('SESSION_SECRET (or GHL_CLIENT_SECRET) must be set in production');
  }
  return crypto
    .createHash('sha256')
    .update('ll-session:' + (config.ghl.clientSecret || config.ghl.sharedSecret || 'dev-only'))
    .digest('hex');
}

function signSession(claims, ttlSec = config.security.sessionTtlSec) {
  const body = { ...claims, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const p = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac('sha256', sessionSecret()).update(p).digest());
  return `${p}.${sig}`;
}

function verifySession(token) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const [p, sig] = token.split('.');
  if (!p || !sig) return null;
  const expected = b64url(crypto.createHmac('sha256', sessionSecret()).update(p).digest());
  if (!safeEqual(sig, expected)) return null;
  try {
    const claims = JSON.parse(fromB64url(p).toString('utf8'));
    if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

// ---------- webhook signature verification ----------
function verifyWebhookSignature(headers, rawBody) {
  const cfg = config.webhook;
  if (!cfg.verify) return { ok: true, method: 'disabled' };
  if (!rawBody || !rawBody.length) return { ok: false, reason: 'empty body' };

  const ed = headers['x-ghl-signature'];
  if (ed) {
    try {
      const ok = crypto.verify(null, rawBody, crypto.createPublicKey(cfg.ed25519Pem), Buffer.from(ed, 'base64'));
      return ok ? { ok: true, method: 'ed25519' } : { ok: false, reason: 'bad ed25519 signature' };
    } catch (e) {
      return { ok: false, reason: 'ed25519 verify error: ' + e.message };
    }
  }

  const rsa = headers['x-wh-signature'];
  if (rsa) {
    if (!cfg.rsaPem) return { ok: false, reason: 'legacy X-WH-Signature received but GHL_WEBHOOK_RSA_PUBLIC_KEY is not set' };
    try {
      const v = crypto.createVerify('RSA-SHA256');
      v.update(rawBody);
      v.end();
      return v.verify(cfg.rsaPem, rsa, 'base64') ? { ok: true, method: 'rsa' } : { ok: false, reason: 'bad rsa signature' };
    } catch (e) {
      return { ok: false, reason: 'rsa verify error: ' + e.message };
    }
  }
  return { ok: false, reason: 'missing signature header' };
}

module.exports = {
  safeEqual,
  encrypt,
  decrypt,
  usingDerivedKey,
  ssoDecrypt,
  ssoEncryptForTests,
  signSession,
  verifySession,
  verifyWebhookSignature,
  sha1: (s) => crypto.createHash('sha1').update(s).digest('hex'),
  randomId: (n = 8) => crypto.randomBytes(n).toString('hex'),
  randomKey: () => 'llk_' + crypto.randomBytes(24).toString('base64url')
};
