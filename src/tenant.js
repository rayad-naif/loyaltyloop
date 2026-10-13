'use strict';

/**
 * Per-location (tenant) configuration: rules, settings, defaults, validation.
 * Everything here is keyed by locationId so sub-accounts never see each other's data.
 */

const config = require('./config');
const store = require('./store');
const { K } = store;
const ghl = require('./ghl');
const { randomId, randomKey } = require('./crypto');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.code = 'VALIDATION';
  }
}

const RULE_TYPES = ['Purchase', 'TagAdded', 'Redeem', 'Appointment', 'Signup'];
const APPT_STATUSES = ['showed', 'confirmed'];

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const intIn = (v, min, max, label) => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw new ValidationError(`${label} must be a whole number between ${min} and ${max}`);
  return n;
};

function defaultRules() {
  return [
    { id: 'r_' + randomId(4), type: 'Purchase', multiplier: 1, minAmount: 0, description: 'Earn 1 point per $1 spent' },
    { id: 'r_' + randomId(4), type: 'TagAdded', tag: 'left_review', points: 500, removeTag: false, description: 'Earn 500 points for leaving a review' },
    { id: 'r_' + randomId(4), type: 'Redeem', tag: 'redeem_coffee', points: 500, description: 'Burn 500 points for a free coffee' }
  ];
}

function defaultTiers() {
  return [{ id: 'vip_gold', name: 'VIP Gold', threshold: 1000, tag: 'VIP_Gold' }];
}

function sanitizeRules(input) {
  if (!Array.isArray(input)) throw new ValidationError('rules must be an array');
  if (input.length > config.limits.maxRules) throw new ValidationError(`A maximum of ${config.limits.maxRules} rules is allowed`);
  const seen = new Set();
  return input.map((r) => {
    if (!r || typeof r !== 'object') throw new ValidationError('Invalid rule');
    if (!RULE_TYPES.includes(r.type)) throw new ValidationError(`Unknown rule type "${clean(r.type, 30)}"`);
    let id = typeof r.id === 'string' && /^[\w-]{1,40}$/.test(r.id) && !seen.has(r.id) ? r.id : 'r_' + randomId(5);
    seen.add(id);
    const rule = { id, type: r.type, description: clean(r.description, 140) };

    if (r.type === 'Purchase') {
      const m = Number(r.multiplier);
      if (!(m > 0 && m <= 1000)) throw new ValidationError('Multiplier must be greater than 0 and at most 1000');
      rule.multiplier = Math.round(m * 1000) / 1000;
      const min = Number(r.minAmount || 0);
      rule.minAmount = Number.isFinite(min) && min > 0 ? Math.min(min, 1e9) : 0;
    } else if (r.type === 'TagAdded' || r.type === 'Redeem') {
      rule.tag = clean(r.tag, 60);
      if (!rule.tag) throw new ValidationError('A tag is required for tag rules');
      rule.points = intIn(r.points, 1, config.limits.maxPointsPerAdjust, 'Points');
      if (r.type === 'TagAdded') rule.removeTag = !!r.removeTag;
    } else if (r.type === 'Appointment') {
      const st = String(r.status || '').toLowerCase();
      if (!APPT_STATUSES.includes(st)) throw new ValidationError(`Appointment status must be one of: ${APPT_STATUSES.join(', ')}`);
      rule.status = st;
      rule.points = intIn(r.points, 1, config.limits.maxPointsPerAdjust, 'Points');
    } else if (r.type === 'Signup') {
      rule.points = intIn(r.points, 1, config.limits.maxPointsPerAdjust, 'Points');
    }
    return rule;
  });
}

function sanitizeTiers(input) {
  if (!Array.isArray(input)) throw new ValidationError('tiers must be an array');
  if (input.length > 10) throw new ValidationError('A maximum of 10 tiers is allowed');
  const seen = new Set();
  return input.map((t) => {
    const name = clean(t?.name, 40);
    const tag = clean(t?.tag, 60);
    if (!name || !tag) throw new ValidationError('Every tier needs a name and a tag');
    let id = String(t.id || name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'tier_' + randomId(3);
    while (seen.has(id)) id += '_' + randomId(2);
    seen.add(id);
    return { id, name, tag, threshold: intIn(t.threshold, 1, 1e9, 'Tier threshold') };
  });
}

// ------------------------------------------------------------- storage
async function getRules(loc) {
  return (await store.json.get(K.rules(loc))) || [];
}
async function saveRules(loc, input) {
  const rules = sanitizeRules(input);
  await store.json.set(K.rules(loc), rules);
  return rules;
}
async function getSettings(loc) {
  return (await store.json.get(K.settings(loc))) || null;
}
const saveSettingsRaw = (loc, s) => store.json.set(K.settings(loc), s);

async function updateTiers(loc, tiers) {
  const s = (await getSettings(loc)) || (await ensureLocation(loc));
  s.tiers = sanitizeTiers(tiers);
  await saveSettingsRaw(loc, s);
  return s;
}

async function rotateWebhookKey(loc) {
  const s = (await getSettings(loc)) || (await ensureLocation(loc));
  s.webhookKey = randomKey();
  await saveSettingsRaw(loc, s);
  return s;
}

/** Make sure the points custom field exists; returns the (possibly updated) settings. */
async function ensureField(loc) {
  const s = (await getSettings(loc)) || { webhookKey: randomKey(), tiers: defaultTiers(), createdAt: new Date().toISOString() };
  try {
    const f = await ghl.ensurePointsField(loc);
    s.fieldId = f.id;
    s.fieldKey = f.key;
    s.fieldError = null;
  } catch (e) {
    s.fieldError = e.ghlMessage || e.message;
    console.error(`[tenant] custom field setup failed for ${loc}:`, s.fieldError);
  }
  await saveSettingsRaw(loc, s);
  return s;
}

/** Idempotent per-location bootstrap: settings, default rules, webhook key, custom field. */
async function ensureLocation(loc) {
  let s = await getSettings(loc);
  if (!s) {
    s = { webhookKey: randomKey(), tiers: defaultTiers(), createdAt: new Date().toISOString() };
    await saveSettingsRaw(loc, s);
  }
  if (!(await store.get(K.rules(loc)))) await store.json.set(K.rules(loc), defaultRules());
  if (!s.fieldId) s = await ensureField(loc);
  return s;
}

async function deleteLocationData(loc) {
  await store.del(
    K.install(loc), K.rules(loc), K.settings(loc), K.balances(loc), K.activity(loc),
    K.stats(loc), K.awards(loc), K.names(loc), K.dirty(loc)
  );
  await store.srem(K.locations(), loc);
}

module.exports = {
  ValidationError,
  RULE_TYPES,
  APPT_STATUSES,
  defaultRules,
  sanitizeRules,
  sanitizeTiers,
  getRules,
  saveRules,
  getSettings,
  updateTiers,
  rotateWebhookKey,
  ensureField,
  ensureLocation,
  deleteLocationData
};
