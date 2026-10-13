'use strict';

/**
 * HighLevel (LeadConnector) OAuth + API client.
 *
 * Install records (encrypted at rest):
 *   ll:install:<locationId>  one per sub-account (Location install, or minted from a Company install)
 *   ll:company:<companyId>   the agency-level token, used to mint location tokens
 */

const axios = require('axios');
const config = require('./config');
const store = require('./store');
const { K } = store;
const { encrypt, decrypt } = require('./crypto');

const g = config.ghl;
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class NotInstalledError extends Error {
  constructor(locationId) {
    super(`LoyaltyLoop is not installed for location ${locationId}`);
    this.code = 'NOT_INSTALLED';
    this.status = 403;
  }
}

// ------------------------------------------------------------------ install records
async function loadRecord(key) {
  const raw = await store.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(decrypt(raw));
  } catch (e) {
    console.error(`[ghl] could not decrypt ${key}: ${e.message} (was TOKEN_ENC_KEY / GHL_CLIENT_SECRET changed?)`);
    return null;
  }
}
const saveRecord = (key, rec) => store.set(key, encrypt(JSON.stringify(rec)));
const loadInstall = (loc) => loadRecord(K.install(loc));
const loadCompany = (cid) => loadRecord(K.company(cid));

function tokenFields(data) {
  // /oauth/token returns snake_case; some responses use camelCase. Accept both.
  const access = data.access_token || data.accessToken;
  const expiresIn = Number(data.expires_in || data.expiresIn || 86400);
  return {
    accessToken: access,
    refreshToken: data.refresh_token || data.refreshToken || null,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: data.scope || null
  };
}

// ------------------------------------------------------------------ OAuth calls
async function oauthToken(params) {
  const body = new URLSearchParams({
    client_id: g.clientId,
    client_secret: g.clientSecret,
    ...params
  });
  const res = await axios.post(`${g.apiBase}/oauth/token`, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Version: g.oauthVersion
    },
    timeout: 15000
  });
  return res.data;
}

const exchangeAuthCode = (code) =>
  oauthToken({ grant_type: 'authorization_code', code, redirect_uri: g.redirectUri });

const refreshWith = (refreshToken, userType) =>
  oauthToken({ grant_type: 'refresh_token', refresh_token: refreshToken, user_type: userType, redirect_uri: g.redirectUri });

async function mintLocationToken(companyToken, companyId, locationId) {
  const res = await axios.post(
    `${g.apiBase}/oauth/location-token`,
    new URLSearchParams({ companyId, locationId }).toString(),
    {
      headers: {
        Authorization: `Bearer ${companyToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Version: g.oauthVersion
      },
      timeout: 15000
    }
  );
  return res.data;
}

// ------------------------------------------------------------------ refresh with single-flight + distributed lock
const inflight = new Map();

async function singleFlight(name, work, recheck) {
  if (inflight.has(name)) return inflight.get(name);
  const p = (async () => {
    const lockKey = K.lock(name);
    const got = await store.set(lockKey, '1', { nx: true, ex: 20 });
    if (!got) {
      // another instance is refreshing; wait for its result instead of burning the (rotating) refresh token
      for (let i = 0; i < 12; i++) {
        await sleep(500);
        const v = await recheck();
        if (v) return v;
      }
    }
    try {
      return await work();
    } finally {
      if (got) await store.del(lockKey);
    }
  })();
  inflight.set(name, p);
  try {
    return await p;
  } finally {
    inflight.delete(name);
  }
}

async function getCompanyToken(companyId, { force = false } = {}) {
  const fresh = (rec) => rec && rec.accessToken && rec.expiresAt - Date.now() > REFRESH_SKEW_MS;
  const rec = await loadCompany(companyId);
  if (!rec) throw new Error(`No company install for ${companyId}`);
  if (!force && fresh(rec)) return rec.accessToken;

  return singleFlight(
    `company:${companyId}`,
    async () => {
      const latest = (await loadCompany(companyId)) || rec;
      if (!force && fresh(latest)) return latest.accessToken;
      if (!latest.refreshToken) throw new Error(`No refresh token for company ${companyId}`);
      const data = await refreshWith(latest.refreshToken, 'Company');
      const next = { ...latest, ...tokenFields(data), refreshToken: data.refresh_token || latest.refreshToken, updatedAt: new Date().toISOString() };
      await saveRecord(K.company(companyId), next);
      return next.accessToken;
    },
    async () => {
      const r = await loadCompany(companyId);
      return fresh(r) ? r.accessToken : null;
    }
  );
}

async function getLocationToken(locationId, { force = false } = {}) {
  const fresh = (rec) => rec && rec.accessToken && rec.expiresAt - Date.now() > REFRESH_SKEW_MS;
  const rec = await loadInstall(locationId);
  if (!rec || rec.status === 'uninstalled') throw new NotInstalledError(locationId);
  if (!force && fresh(rec)) return rec.accessToken;

  return singleFlight(
    `location:${locationId}`,
    async () => {
      const latest = (await loadInstall(locationId)) || rec;
      if (!force && fresh(latest)) return latest.accessToken;

      let data;
      if (latest.viaCompany && latest.companyId) {
        const companyToken = await getCompanyToken(latest.companyId, { force });
        data = await mintLocationToken(companyToken, latest.companyId, locationId);
      } else {
        if (!latest.refreshToken) throw new Error(`No refresh token for location ${locationId}`);
        data = await refreshWith(latest.refreshToken, 'Location');
      }
      const next = { ...latest, ...tokenFields(data), refreshToken: data.refresh_token || data.refreshToken || latest.refreshToken, updatedAt: new Date().toISOString() };
      await saveRecord(K.install(locationId), next);
      return next.accessToken;
    },
    async () => {
      const r = await loadInstall(locationId);
      return fresh(r) ? r.accessToken : null;
    }
  );
}

// ------------------------------------------------------------------ resilient API wrapper
/**
 * api(locationId, { method, path, params, data })
 * - adds auth + Version headers
 * - 401 -> force-refresh the token and retry once
 * - 429 -> back off (honours Retry-After) and retry up to 3 times
 */
async function api(locationId, { method = 'get', path, params, data, version }, attempt = {}) {
  const token = await getLocationToken(locationId, { force: !!attempt.forced });
  try {
    return await axios({
      method,
      url: `${g.apiBase}${path}`,
      params,
      data,
      headers: {
        Authorization: `Bearer ${token}`,
        Version: version || g.apiVersion,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 && !attempt.forced) return api(locationId, { method, path, params, data, version }, { ...attempt, forced: true });
    if (status === 429 && (attempt.n || 0) < 3) {
      const ra = Number(err.response.headers?.['retry-after']);
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * ((attempt.n || 0) + 1));
      return api(locationId, { method, path, params, data, version }, { ...attempt, n: (attempt.n || 0) + 1 });
    }
    err.ghlMessage = err.response?.data?.message || err.message;
    throw err;
  }
}

// ------------------------------------------------------------------ CRM operations
const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

async function getContact(locationId, contactId) {
  const res = await api(locationId, { path: `/contacts/${encodeURIComponent(contactId)}` });
  return res.data?.contact || res.data || null;
}

async function setContactField(locationId, contactId, fieldId, value) {
  await api(locationId, {
    method: 'put',
    path: `/contacts/${encodeURIComponent(contactId)}`,
    data: { customFields: [{ id: fieldId, field_value: String(value) }] }
  });
}

async function addTags(locationId, contactId, tags) {
  if (!tags.length) return;
  await api(locationId, { method: 'post', path: `/contacts/${encodeURIComponent(contactId)}/tags`, data: { tags } });
}

async function removeTags(locationId, contactId, tags) {
  if (!tags.length) return;
  await api(locationId, { method: 'delete', path: `/contacts/${encodeURIComponent(contactId)}/tags`, data: { tags } });
}

async function searchContacts(locationId, query, limit = 10) {
  const res = await api(locationId, { path: '/contacts/', params: { locationId, query, limit } });
  return (res.data?.contacts || []).map((c) => ({
    id: c.id,
    name: c.contactName || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c.phone || c.id,
    email: c.email || '',
    phone: c.phone || ''
  }));
}

const FIELD_NAME = 'Loyalty Points Balance';
const FIELD_KEY = 'contact.loyalty_points_balance';

async function ensurePointsField(locationId) {
  const list = await api(locationId, { path: `/locations/${locationId}/customFields`, params: { model: 'contact' } });
  const fields = list.data?.customFields || [];
  const found = fields.find((f) => f.fieldKey === FIELD_KEY) || fields.find((f) => (f.name || '').trim().toLowerCase() === FIELD_NAME.toLowerCase());
  if (found) return { id: found.id, key: found.fieldKey || FIELD_KEY };

  const created = await api(locationId, {
    method: 'post',
    path: `/locations/${locationId}/customFields`,
    data: { name: FIELD_NAME, dataType: 'NUMERICAL', placeholder: '0', model: 'contact' }
  });
  const f = created.data?.customField || created.data;
  if (!f?.id) throw new Error('Custom field was created but no id was returned');
  return { id: f.id, key: f.fieldKey || FIELD_KEY };
}

// ------------------------------------------------------------------ install helpers
function idsFrom(list) {
  return asArray(list)
    .map((l) => (typeof l === 'string' ? l : l?.locationId || l?._id || l?.id))
    .filter(Boolean);
}

async function listCompanyLocations(companyToken, companyId) {
  const found = new Set();
  if (g.appId) {
    try {
      let skip = 0;
      for (let i = 0; i < 20; i++) {
        const r = await axios.get(`${g.apiBase}/oauth/installedLocations`, {
          params: { companyId, appId: g.appId, isInstalled: true, limit: 100, skip },
          headers: { Authorization: `Bearer ${companyToken}`, Version: '2021-07-28', Accept: 'application/json' },
          timeout: 15000
        });
        const page = idsFrom(r.data?.locations || r.data?.installedLocations || r.data?.data);
        page.forEach((x) => found.add(x));
        if (page.length < 100) break;
        skip += 100;
      }
    } catch (e) {
      console.warn('[oauth] installedLocations failed:', e.response?.data?.message || e.message);
    }
  }
  if (found.size === 0) {
    try {
      const r = await axios.get(`${g.apiBase}/locations/search`, {
        params: { companyId, limit: 100 },
        headers: { Authorization: `Bearer ${companyToken}`, Version: '2021-07-28', Accept: 'application/json' },
        timeout: 15000
      });
      idsFrom(r.data?.locations).forEach((x) => found.add(x));
    } catch (e) {
      console.warn('[oauth] locations/search failed:', e.response?.data?.message || e.message);
    }
  }
  return [...found];
}

/** Save a location install from a /oauth/token (Location) response. */
async function saveLocationInstall(data, extra = {}) {
  const prev = (await loadInstall(data.locationId)) || {};
  const rec = {
    ...prev,
    locationId: data.locationId,
    companyId: data.companyId || prev.companyId || null,
    userId: data.userId || prev.userId || null,
    userType: 'Location',
    viaCompany: false,
    status: 'active',
    ...tokenFields(data),
    installedAt: prev.installedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra
  };
  await saveRecord(K.install(rec.locationId), rec);
  await store.sadd(K.locations(), rec.locationId);
  return rec;
}

async function saveCompanyInstall(data) {
  const prev = (await loadCompany(data.companyId)) || {};
  const rec = {
    ...prev,
    companyId: data.companyId,
    userId: data.userId || prev.userId || null,
    userType: 'Company',
    isBulk: !!data.isBulkInstallation,
    installToFutureLocations: !!data.installToFutureLocations,
    ...tokenFields(data),
    installedAt: prev.installedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await saveRecord(K.company(rec.companyId), rec);
  return rec;
}

/** Mint + save a location token from a stored company token. Returns the install record or null. */
async function installLocationViaCompany(companyId, locationId) {
  const company = await loadCompany(companyId);
  if (!company) return null;
  try {
    const companyToken = await getCompanyToken(companyId);
    const data = await mintLocationToken(companyToken, companyId, locationId);
    const prev = (await loadInstall(locationId)) || {};
    const rec = {
      ...prev,
      locationId,
      companyId,
      userId: data.userId || company.userId || null,
      userType: 'Location',
      viaCompany: true,
      status: 'active',
      ...tokenFields(data),
      installedAt: prev.installedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await saveRecord(K.install(locationId), rec);
    await store.sadd(K.locations(), locationId);
    return rec;
  } catch (e) {
    console.warn(`[oauth] could not mint token for ${locationId}:`, e.response?.data?.message || e.message);
    return null;
  }
}

async function removeInstall(locationId) {
  await store.del(K.install(locationId));
  await store.srem(K.locations(), locationId);
}

module.exports = {
  NotInstalledError,
  FIELD_NAME,
  FIELD_KEY,
  exchangeAuthCode,
  loadInstall,
  loadCompany,
  saveLocationInstall,
  saveCompanyInstall,
  installLocationViaCompany,
  listCompanyLocations,
  removeInstall,
  idsFrom,
  getLocationToken,
  api,
  getContact,
  setContactField,
  addTags,
  removeTags,
  searchContacts,
  ensurePointsField
};
