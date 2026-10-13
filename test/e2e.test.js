'use strict';

// End-to-end test: boots the real Express app and fakes HighLevel by replacing axios' adapter.
process.env.GHL_CLIENT_ID = 'test-client';
process.env.GHL_CLIENT_SECRET = 'test-secret';
process.env.GHL_SHARED_SECRET = 'shared-secret-for-tests';
process.env.APP_BASE_URL = 'http://localhost:3999';
delete process.env.UPSTASH_REDIS_REST_URL;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const axios = require('axios');

const config = require('../src/config');
const store = require('../src/store');
store._useMemory();
const { K } = store;
const cx = require('../src/crypto');
const ghl = require('../src/ghl');
const app = require('../src/app');

// ---- test signing key (replaces HighLevel's public key for the duration of the tests)
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
config.webhook.ed25519Pem = publicKey.export({ type: 'spki', format: 'pem' });
const sign = (raw) => crypto.sign(null, Buffer.from(raw), privateKey).toString('base64');

// ---- fake HighLevel
const calls = [];
const crm = { contacts: {}, fieldId: 'FIELD1', failFieldPut: false, tokenRefreshes: 0 };
const mkContact = (id, extra = {}) => (crm.contacts[id] ||= { id, firstName: 'Contact', lastName: id, tags: [], customFields: [], ...extra });

axios.defaults.adapter = async (config) => {
  const url = new URL(config.url);
  const path = url.pathname;
  const method = (config.method || 'get').toLowerCase();
  const body = typeof config.data === 'string' && config.data.startsWith('{') ? JSON.parse(config.data) : config.data;
  calls.push({ method, path, body });
  const ok = (data, status = 200) => ({ data, status, statusText: 'OK', headers: {}, config });
  const fail = (status, data = {}) => {
    throw new axios.AxiosError('fail ' + status, 'ERR', config, null, { data, status, statusText: 'x', headers: {}, config });
  };

  if (path === '/oauth/token') {
    crm.tokenRefreshes++;
    return ok({ access_token: 'access-' + crm.tokenRefreshes, refresh_token: 'refresh-' + crm.tokenRefreshes, expires_in: 86400, userType: 'Location', locationId: 'LOC1', companyId: 'COMP1', userId: 'U1' });
  }
  if (path === '/locations/LOC1/customFields' && method === 'get') return ok({ customFields: crm.fieldCreated ? [{ id: crm.fieldId, name: 'Loyalty Points Balance', fieldKey: 'contact.loyalty_points_balance' }] : [] });
  if (path === '/locations/LOC1/customFields' && method === 'post') {
    crm.fieldCreated = true;
    return ok({ customField: { id: crm.fieldId, fieldKey: 'contact.loyalty_points_balance' } });
  }
  const m = path.match(/^\/contacts\/([^/]+)(\/tags)?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const c = crm.contacts[id];
    if (!c) return fail(404);
    if (m[2] && method === 'post') { c.tags = [...new Set([...c.tags, ...body.tags])]; return ok({ tags: c.tags }); }
    if (m[2] && method === 'delete') { c.tags = c.tags.filter((t) => !body.tags.includes(t)); return ok({ tags: c.tags }); }
    if (method === 'get') return ok({ contact: c });
    if (method === 'put') {
      if (crm.failFieldPut) return fail(500, { message: 'boom' });
      for (const f of body.customFields) {
        c.customFields = c.customFields.filter((x) => x.id !== f.id).concat({ id: f.id, value: f.field_value });
      }
      return ok({ contact: c });
    }
  }
  if (path === '/contacts/' && method === 'get') return ok({ contacts: Object.values(crm.contacts).map((c) => ({ ...c, contactName: `${c.firstName} ${c.lastName}` })) });
  return fail(404, { message: 'unhandled ' + method + ' ' + path });
};

// ---- helpers
let server;
let base;
test.before(async () => {
  await new Promise((r) => (server = app.listen(0, '127.0.0.1', r)));
  base = `http://127.0.0.1:${server.address().port}`;
  await ghl.saveLocationInstall({ access_token: 'access-0', refresh_token: 'refresh-0', expires_in: 86400, locationId: 'LOC1', companyId: 'COMP1', userId: 'U1' });
});
test.after(() => server.close());

const j = async (method, path, { body, token, headers } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};
const webhook = async (payload, { signed = true } = {}) => {
  const raw = JSON.stringify(payload);
  return fetch(base + '/webhook/leadconnector', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signed ? { 'X-GHL-Signature': sign(raw) } : {}) },
    body: raw
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
};
const sso = (obj) => j('POST', '/sso/session', { body: { key: cx.ssoEncryptForTests(obj, config.ghl.sharedSecret) } });
const bal = (id) => store.zscore(K.balances('LOC1'), id);

let token;

test('SSO: valid payload signs in; bad payload and uninstalled location are rejected', async () => {
  const ok = await sso({ activeLocation: 'LOC1', companyId: 'COMP1', userId: 'U1', userName: 'Tester' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  token = ok.body.token;

  assert.equal((await j('POST', '/sso/session', { body: { key: 'garbage' } })).status, 400);
  assert.equal((await j('POST', '/sso/session', { body: {} })).status, 400);

  const wrongSecret = cx.ssoEncryptForTests({ activeLocation: 'LOC1' }, 'someone-elses-secret');
  assert.equal((await j('POST', '/sso/session', { body: { key: wrongSecret } })).status, 400);

  const other = await sso({ activeLocation: 'LOC_NOT_INSTALLED', companyId: 'NOPE', userId: 'U9' });
  assert.equal(other.status, 403);
  const agency = await sso({ companyId: 'COMP1', userId: 'U1' });
  assert.equal(agency.status, 409);
});

test('API requires a session; tampered/expired tokens fail', async () => {
  assert.equal((await j('GET', '/api/overview')).status, 401);
  assert.equal((await j('GET', '/api/overview', { token: token + 'x' })).status, 401);
  assert.equal((await j('GET', '/api/overview', { token: cx.signSession({ loc: 'LOC1' }, -10) })).status, 401);
});

test('first open bootstraps the location: custom field, default rules, webhook key', async () => {
  const r = await j('GET', '/api/overview', { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.field.id, 'FIELD1');
  assert.equal(r.body.rulesCount, 3);
  assert.match(r.body.workflow.key, /^llk_/);
  assert.equal(r.body.workflow.url, 'http://localhost:3999/webhook/workflow/LOC1');
});

test('rules: validation, XSS-ish input is sanitised, per-location persistence', async () => {
  const bad = await j('PUT', '/api/rules', { token, body: { rules: [{ type: 'Hack' }] } });
  assert.equal(bad.status, 400);
  const bad2 = await j('PUT', '/api/rules', { token, body: { rules: [{ type: 'TagAdded', tag: 'x', points: -5 }] } });
  assert.equal(bad2.status, 400);

  const rules = [
    { id: 'p1', type: 'Purchase', multiplier: 2, minAmount: 10, description: 'Double <b>points</b>' },
    { id: 'rev', type: 'TagAdded', tag: 'Left_Review', points: 500 },
    { id: 'rep', type: 'TagAdded', tag: 'checked_in', points: 10, removeTag: true },
    { id: 'red', type: 'Redeem', tag: 'redeem_coffee', points: 300 },
    { id: 'ap', type: 'Appointment', status: 'showed', points: 100 },
    { id: 'su', type: 'Signup', points: 50 }
  ];
  const ok = await j('PUT', '/api/rules', { token, body: { rules } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.rules[0].description, 'Double bpoints/b'); // angle brackets stripped
  const got = await j('GET', '/api/rules', { token });
  assert.equal(got.body.rules.length, 6);
});

test('webhook: unsigned and badly signed requests are rejected', async () => {
  const payload = { type: 'ContactTagUpdate', locationId: 'LOC1', id: 'CON1', tags: ['left_review'] };
  assert.equal((await webhook(payload, { signed: false })).status, 401);
  const raw = JSON.stringify(payload);
  const res = await fetch(base + '/webhook/leadconnector', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GHL-Signature': sign(raw + 'tamper') }, body: raw });
  assert.equal(res.status, 401);
  assert.equal(await bal('CON1'), null);
});

test('invoice paid: points = amount x multiplier, once per invoice, mirrored to the CRM field', async () => {
  mkContact('CON1', { firstName: 'Ada', lastName: 'Lovelace' });
  const inv = { _id: 'INV1', status: 'paid', amountPaid: 120.5, total: 120.5, currency: 'USD', altId: 'LOC1', altType: 'location', contactDetails: { id: 'CON1', name: 'Ada Lovelace' } };
  const r1 = await webhook(inv);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.status, 'processed');
  assert.equal(await bal('CON1'), 241); // floor(120.5 * 2)
  assert.equal(crm.contacts.CON1.customFields.find((f) => f.id === 'FIELD1').value, '241');

  // identical redelivery + same invoice re-sent as "updated" (different body) must not double pay
  assert.equal((await webhook(inv)).body.status, 'duplicate');
  const again = await webhook({ ...inv, updatedAt: 'later' });
  assert.equal(again.body.status, 'no_matching_rule');
  assert.equal(await bal('CON1'), 241);

  // unpaid invoices and amounts under the minimum earn nothing
  assert.equal((await webhook({ ...inv, _id: 'INV2', status: 'sent' })).body.status, 'ignored');
  assert.equal((await webhook({ ...inv, _id: 'INV3', amountPaid: 5, total: 5 })).body.status, 'no_matching_rule');
  assert.equal(await bal('CON1'), 241);
});

test('tags: earn once per contact (case-insensitive), repeatable tag is removed, VIP tier tag added', async () => {
  const tagEvt = (tags, extra = {}) => ({ type: 'ContactTagUpdate', locationId: 'LOC1', id: 'CON1', tags, ...extra });
  crm.contacts.CON1.tags = ['left_review'];
  assert.equal((await webhook(tagEvt(['left_review'], { dateUpdated: '1' }))).body.status, 'processed');
  assert.equal(await bal('CON1'), 741);
  // another tag update while the tag is still present does not pay again
  assert.equal((await webhook(tagEvt(['Left_Review', 'x'], { dateUpdated: '2' }))).body.status, 'no_matching_rule');
  assert.equal(await bal('CON1'), 741);

  // repeatable tag
  crm.contacts.CON1.tags = ['checked_in'];
  await webhook(tagEvt(['checked_in'], { dateUpdated: '3' }));
  assert.equal(await bal('CON1'), 751);
  assert.deepEqual(crm.contacts.CON1.tags.includes('checked_in'), false);
  crm.contacts.CON1.tags.push('checked_in');
  await webhook(tagEvt(['checked_in'], { dateUpdated: '4' }));
  assert.equal(await bal('CON1'), 761);

  // 761 -> 1000+ crosses the VIP threshold exactly once
  for (let i = 0; i < 24; i++) {
    crm.contacts.CON1.tags.push('checked_in');
    await webhook(tagEvt(['checked_in'], { dateUpdated: 'x' + i }));
  }
  assert.equal(await bal('CON1'), 1001);
  assert.equal(crm.contacts.CON1.tags.filter((t) => t === 'VIP_Gold').length, 1);
});

test('redeem: deducts and clears the tag; refused (nothing deducted) when balance is too low', async () => {
  crm.contacts.CON1.tags = ['redeem_coffee'];
  const r = await webhook({ type: 'ContactTagUpdate', locationId: 'LOC1', id: 'CON1', tags: ['redeem_coffee'], dateUpdated: 'r1' });
  assert.equal(r.body.balance, 701);
  assert.equal(crm.contacts.CON1.tags.includes('redeem_coffee'), false);

  mkContact('POOR');
  crm.contacts.POOR.tags = ['redeem_coffee'];
  const p = await webhook({ type: 'ContactTagUpdate', locationId: 'LOC1', id: 'POOR', tags: ['redeem_coffee'] });
  assert.equal(p.status, 200);
  assert.equal(await bal('POOR'), 0);
  assert.equal(crm.contacts.POOR.tags.includes('redeem_coffee'), false);
  const act = await j('GET', '/api/activity', { token });
  assert.ok(act.body.items.some((i) => i.contactId === 'POOR' && i.ok === false && /not enough points/.test(i.reason)));
});

test('appointments and signup bonus pay once', async () => {
  mkContact('CON2', { firstName: 'Grace', lastName: 'Hopper' });
  const appt = { type: 'AppointmentUpdate', locationId: 'LOC1', appointment: { id: 'APT1', contactId: 'CON2', appointmentStatus: 'showed', locationId: 'LOC1' } };
  assert.equal((await webhook(appt)).body.balance, 100);
  assert.equal((await webhook({ ...appt, timestamp: 2 })).body.status, 'no_matching_rule');
  assert.equal((await webhook({ ...appt, appointment: { ...appt.appointment, appointmentStatus: 'confirmed' } })).body.status, 'no_matching_rule');

  mkContact('CON3');
  const create = { type: 'ContactCreate', locationId: 'LOC1', id: 'CON3', firstName: 'New', lastName: 'Person' };
  assert.equal((await webhook(create)).body.balance, 50);
  assert.equal((await webhook({ ...create, dateAdded: 'dup' })).body.status, 'no_matching_rule');
});

test('envelope-style payload ({type, webhookId, data}) is understood and webhookId dedupes', async () => {
  mkContact('CON4');
  const env = { type: 'ContactCreate', webhookId: 'WH-1', timestamp: 1, data: { locationId: 'LOC1', id: 'CON4' } };
  assert.equal((await webhook(env)).body.balance, 50);
  assert.equal((await webhook(env)).body.status, 'duplicate');
});

test('events for locations that are not installed are ignored', async () => {
  const r = await webhook({ type: 'ContactCreate', locationId: 'GHOST', id: 'X' });
  assert.equal(r.body.status, 'not_installed');
  assert.equal(await store.zscore(K.balances('GHOST'), 'X'), null);
});

test('CRM failure never loses points; contact is queued and re-synced', async () => {
  mkContact('CON5');
  crm.failFieldPut = true;
  const r = await webhook({ type: 'ContactCreate', locationId: 'LOC1', id: 'CON5' });
  assert.equal(r.body.status, 'processed');
  assert.equal(r.body.crmOk, false);
  assert.equal(await bal('CON5'), 50);
  assert.equal((await j('GET', '/api/overview', { token })).body.pendingSync, 1);
  crm.failFieldPut = false;
  const fix = await j('POST', '/api/resync', { token });
  assert.equal(fix.body.fixed, 1);
  assert.equal(crm.contacts.CON5.customFields.find((f) => f.id === 'FIELD1').value, '50');
});

test('existing CRM field value seeds the ledger (reinstall / migration)', async () => {
  mkContact('OLD', { customFields: [{ id: 'FIELD1', value: '250' }] });
  const r = await webhook({ type: 'ContactCreate', locationId: 'LOC1', id: 'OLD' });
  assert.equal(r.body.balance, 300);
});

test('dashboard: manual adjust, insufficient burn, leaderboard, search', async () => {
  const c = '/api/contacts/CON2/adjust';
  assert.equal((await j('POST', c, { token, body: { points: 25, reason: 'bonus' } })).body.balance, 125);
  const over = await j('POST', c, { token, body: { points: -1000 } });
  assert.equal(over.status, 409);
  assert.equal(await bal('CON2'), 125);
  assert.equal((await j('POST', c, { token, body: { points: 0 } })).status, 400);
  assert.equal((await j('POST', c, { token, body: { points: 'abc' } })).status, 400);

  const lb = await j('GET', '/api/leaderboard', { token });
  assert.equal(lb.body.rows[0].contactId, 'CON1');
  assert.equal(lb.body.rows[0].name, 'Ada Lovelace');

  const s = await j('GET', '/api/contacts/search?q=Ada', { token });
  assert.ok(s.body.contacts.length >= 1);
  assert.equal(s.body.contacts.find((x) => x.id === 'CON1').points, 701);
});

test('workflow webhook: key required, earn/burn, idempotency, insufficient points', async () => {
  const key = (await j('GET', '/api/overview', { token })).body.workflow.key;
  const url = '/webhook/workflow/LOC1';
  const body = { contactId: 'CON2', action: 'earn', points: 40, reason: 'event' };
  assert.equal((await j('POST', url, { body })).status, 401);
  assert.equal((await j('POST', url, { body, headers: { 'x-api-key': 'llk_wrong' } })).status, 401);
  assert.equal((await j('POST', '/webhook/workflow/OTHER', { body, headers: { 'x-api-key': key } })).status, 401);

  const a = await j('POST', url, { body: { ...body, idempotencyKey: 'k1' }, headers: { 'x-api-key': key } });
  assert.equal(a.body.balance, 165);
  assert.equal((await j('POST', url, { body: { ...body, idempotencyKey: 'k1' }, headers: { 'x-api-key': key } })).body.status, 'duplicate');
  assert.equal((await j('POST', url, { body: { contactId: 'CON2', action: 'burn', points: 10000 }, headers: { 'x-api-key': key } })).status, 409);
  assert.equal((await j('POST', url, { body: { contactId: 'CON2', action: 'nope', points: 1 }, headers: { 'x-api-key': key } })).status, 400);

  const rot = await j('POST', '/api/webhook-key/rotate', { token });
  assert.notEqual(rot.body.key, key);
  assert.equal((await j('POST', url, { body, headers: { 'x-api-key': key } })).status, 401);
});

test('tiers: validated and saved', async () => {
  assert.equal((await j('PUT', '/api/tiers', { token, body: { tiers: [{ name: '', threshold: 5, tag: 'x' }] } })).status, 400);
  const ok = await j('PUT', '/api/tiers', { token, body: { tiers: [{ name: 'Silver', threshold: 200, tag: 'VIP_Silver' }] } });
  assert.equal(ok.body.tiers[0].id, 'silver');
});

test('token refresh: expired location token is refreshed before the API call', async () => {
  const rec = await ghl.loadInstall('LOC1');
  const before = crm.tokenRefreshes;
  const stored = { ...rec, expiresAt: Date.now() - 1000 };
  await store.set(K.install('LOC1'), cx.encrypt(JSON.stringify(stored)));
  await ghl.getContact('LOC1', 'CON1');
  assert.equal(crm.tokenRefreshes, before + 1);
  const after = await ghl.loadInstall('LOC1');
  assert.ok(after.expiresAt > Date.now() + 3600 * 1000);
});

test('tokens are encrypted at rest', async () => {
  const raw = await store.get(K.install('LOC1'));
  assert.match(raw, /^v1\./);
  assert.ok(!raw.includes('access-'));
});

test('OAuth callback: Location install saves tokens and bootstraps; failures render a friendly page', async () => {
  const before = crm.tokenRefreshes;
  const res = await fetch(base + '/oauth/callback/lc?code=abc', { redirect: 'manual' });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /LoyaltyLoop is installed/);
  assert.equal(crm.tokenRefreshes, before + 1);
  assert.equal((await fetch(base + '/oauth/callback/lc')).status, 400);
  assert.equal((await fetch(base + '/oauth/callback/lc?error=access_denied&error_description=%3Cscript%3E')).status, 400);
  const e = await (await fetch(base + '/oauth/callback/lc?error=x&error_description=%3Cscript%3Ealert(1)%3C/script%3E')).text();
  assert.ok(!e.includes('<script>alert(1)'));
  const inst = await fetch(base + '/install', { redirect: 'manual' });
  assert.equal(inst.status, 302);
  assert.match(inst.headers.get('location'), /marketplace\.gohighlevel\.com\/oauth\/chooselocation.*client_id=test-client/);
});

test('static pages, dashboard shell, headers, health', async () => {
  for (const p of ['/', '/docs', '/support', '/privacy', '/terms']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  }
  assert.match(await (await fetch(base + '/support')).text(), /idylle_radieuse@outlook\.com/);
  const a = await fetch(base + '/app');
  assert.equal(a.status, 200);
  assert.match(a.headers.get('content-security-policy'), /frame-ancestors \*/);
  assert.equal((await fetch(base + '/nope')).status, 404);
  const h = await (await fetch(base + '/health')).json();
  assert.equal(h.status, 'ok');
  assert.ok(!JSON.stringify(h).includes('test-secret'));
});

test('uninstall webhook deletes the location data and kills sessions', async () => {
  const r = await webhook({ type: 'UNINSTALL', appId: 'A', locationId: 'LOC1', companyId: 'COMP1' });
  assert.equal(r.body.status, 'location_removed');
  assert.equal(await store.get(K.install('LOC1')), null);
  assert.equal(await store.get(K.rules('LOC1')), null);
  assert.equal(await bal('CON1'), null);
  assert.equal((await j('GET', '/api/overview', { token })).status, 403);
  assert.equal((await webhook({ type: 'ContactCreate', locationId: 'LOC1', id: 'CON1' })).body.status, 'not_installed');
});
