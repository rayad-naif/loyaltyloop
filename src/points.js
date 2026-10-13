'use strict';

/**
 * Points engine.
 *
 * Source of truth for balances is OUR ledger (a Redis sorted set per location,
 * adjusted atomically). After every change the balance is mirrored onto the
 * contact's "Loyalty Points Balance" custom field in HighLevel so workflows,
 * smart lists and merge fields can use it.
 *
 * Idempotency: every webhook delivery is claimed once (by webhookId / body hash),
 * and every award is claimed once per contact + rule + source object (invoice,
 * appointment, tag, ...), so retries and repeated "contact updated" events can
 * never double-pay.
 */

const config = require('./config');
const defaultStore = require('./store');
const defaultGhl = require('./ghl');
const defaultTenant = require('./tenant');
const { sha1 } = require('./crypto');

const lc = (s) => String(s || '').trim().toLowerCase();
const asTags = (v) =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [])
    .map((t) => String(t).trim())
    .filter(Boolean);

// ------------------------------------------------------------------ payload normalisation
function normalize(body) {
  if (!body || typeof body !== 'object') return null;
  const p = { ...body, ...(body.data && typeof body.data === 'object' ? body.data : {}) };
  const type = String(body.type || p.type || '');
  const locationId =
    p.locationId || p.location_id || (p.altType === 'location' ? p.altId : null) || p.appointment?.locationId || null;

  if (/^(app)?install$/i.test(type)) return { kind: 'install', locationId, companyId: p.companyId, userId: p.userId };
  if (/^(app)?uninstall$/i.test(type)) return { kind: 'uninstall', locationId, companyId: p.companyId };
  if (!locationId) return null;

  if (/^Invoice/i.test(type) || (!type && (p.invoiceItems || (p.contactDetails && ('amountPaid' in p || 'total' in p))))) {
    if (type && !/^Invoice(Paid|Update)$/i.test(type)) return { kind: 'ignored', locationId, type };
    return {
      kind: 'invoice',
      locationId,
      invoiceId: p._id || p.id,
      contactId: p.contactDetails?.id || p.contactId || null,
      status: lc(p.status),
      amount: Number(p.amountPaid) > 0 ? Number(p.amountPaid) : Number(p.total) || 0,
      currency: p.currency || ''
    };
  }

  if (/^Appointment/i.test(type) || p.appointment) {
    const a = p.appointment || p;
    return {
      kind: 'appointment',
      locationId,
      appointmentId: a.id,
      contactId: a.contactId || null,
      status: lc(a.appointmentStatus || a.status),
      name: undefined
    };
  }

  if (type === 'ContactCreate' || type === 'ContactTagUpdate') {
    return {
      kind: type === 'ContactCreate' ? 'contact_create' : 'contact_tags',
      locationId,
      contactId: p.id || p.contactId || p.contact_id || null,
      tags: asTags(p.tags),
      name: p.name || [p.firstName, p.lastName].filter(Boolean).join(' ') || undefined
    };
  }
  return { kind: 'ignored', locationId, type };
}

// ------------------------------------------------------------------ engine
function createEngine({ store = defaultStore, ghl = defaultGhl, tenant = defaultTenant } = {}) {
  const { K } = store;

  const claim = async (ctx, loc, field) => {
    const ok = await store.hsetnx(K.awards(loc), field, Date.now());
    if (ok) ctx.markers.push({ loc, field });
    return ok;
  };
  const undo = async (ctx) => {
    for (const m of ctx.markers) {
      try {
        await store.hdel(K.awards(m.loc), m.field);
      } catch {
        /* best effort */
      }
    }
  };

  async function rememberName(loc, contactId, name) {
    if (name) await store.hset(K.names(loc), contactId, String(name).slice(0, 80));
  }

  /** Make sure a contact has a ledger entry; seed it from the CRM field (reinstall / existing points). */
  async function ensureSeeded(loc, contactId, settings) {
    const cur = await store.zscore(K.balances(loc), contactId);
    if (cur !== null) return cur;
    let seed = 0;
    try {
      const c = await ghl.getContact(loc, contactId);
      const f = (c?.customFields || []).find((x) => x.id === settings.fieldId);
      seed = Math.max(0, Math.floor(Number(f?.value ?? f?.field_value) || 0));
      await rememberName(loc, contactId, c?.contactName || [c?.firstName, c?.lastName].filter(Boolean).join(' '));
    } catch (e) {
      if (e.response?.status !== 404) throw e; // transient -> let the webhook be retried rather than seeding 0
    }
    const r = await store.adjust(K.balances(loc), contactId, seed, false);
    return r.balance;
  }

  async function logActivity(loc, entry) {
    await store.lpushTrim(K.activity(loc), JSON.stringify({ t: new Date().toISOString(), ...entry }), config.limits.activityKeep);
  }

  /**
   * Run a set of ledger changes + CRM side effects for ONE contact.
   * changes: [{ delta, reason, source, strict }]
   */
  async function applyToContact(loc, contactId, { changes, addTags = [], removeTags = [], name, ctx }) {
    const settings = (await tenant.getSettings(loc)) || (await tenant.ensureLocation(loc));
    await ensureSeeded(loc, contactId, settings);
    if (name) await rememberName(loc, contactId, name);

    let balance = await store.zscore(K.balances(loc), contactId);
    let earned = 0;
    let burned = 0;
    let touched = false;
    const results = [];

    for (const ch of changes) {
      const r = await store.adjust(K.balances(loc), contactId, ch.delta, !!ch.strict);
      const displayName = (await store.hget(K.names(loc), contactId)) || '';
      if (r.ok && r.applied !== 0) {
        touched = true;
        balance = r.balance;
        if (r.applied > 0) earned += r.applied;
        else burned += -r.applied;
        await logActivity(loc, { contactId, name: displayName, delta: r.applied, balance: r.balance, reason: ch.reason, source: ch.source, ok: true });
      } else if (!r.ok) {
        await logActivity(loc, { contactId, name: displayName, delta: ch.delta, balance: r.balance, reason: `${ch.reason} (not enough points)`, source: ch.source, ok: false });
      }
      results.push({ requested: ch.delta, ...r });
    }

    if (earned) await store.hincrby(K.stats(loc), 'earned', earned);
    if (burned) await store.hincrby(K.stats(loc), 'burned', burned);
    if (touched) await store.hincrby(K.stats(loc), 'events', 1);

    // VIP tiers: tag once when the balance first reaches a threshold
    const tierMarkers = [];
    const tagsToAdd = [...addTags];
    if (earned) {
      for (const tier of settings.tiers || []) {
        if (balance >= tier.threshold && (await claim(ctx, loc, `tier:${contactId}:${tier.id}`))) {
          tierMarkers.push(`tier:${contactId}:${tier.id}`);
          tagsToAdd.push(tier.tag);
        }
      }
    }

    // Mirror to the CRM. The ledger is already saved, so a CRM failure never loses points:
    // the contact is flagged and can be re-synced from the dashboard.
    let crmOk = true;
    if (touched && settings.fieldId) {
      try {
        await ghl.setContactField(loc, contactId, settings.fieldId, balance);
      } catch (e) {
        crmOk = false;
        console.error(`[points] field sync failed for ${contactId}@${loc}:`, e.ghlMessage || e.message);
      }
    }
    try {
      await ghl.addTags(loc, contactId, [...new Set(tagsToAdd)]);
    } catch (e) {
      crmOk = false;
      for (const f of tierMarkers) await store.hdel(K.awards(loc), f).catch(() => {});
      console.error(`[points] add tags failed for ${contactId}@${loc}:`, e.ghlMessage || e.message);
    }
    try {
      await ghl.removeTags(loc, contactId, [...new Set(removeTags)]);
    } catch (e) {
      crmOk = false;
      console.error(`[points] remove tags failed for ${contactId}@${loc}:`, e.ghlMessage || e.message);
    }
    if (!crmOk) await store.sadd(K.dirty(loc), contactId);

    return { balance, earned, burned, crmOk, results };
  }

  // ---------------------------------------------------------------- event evaluators
  function tagChanges(rules, evt, ctx, loc) {
    return (async () => {
      const lowerTags = new Set(evt.tags.map(lc));
      const originalByLower = new Map(evt.tags.map((t) => [lc(t), t]));
      const changes = [];
      const removeTags = [];

      for (const rule of rules.filter((r) => r.type === 'TagAdded')) {
        if (!lowerTags.has(lc(rule.tag))) continue;
        // removeTag rules are repeatable (the tag is removed so it can fire again); others pay once per contact
        if (!rule.removeTag && !(await claim(ctx, loc, `tag:${evt.contactId}:${rule.id}`))) continue;
        changes.push({ delta: rule.points, reason: rule.description || `Tag "${rule.tag}"`, source: 'tag' });
        if (rule.removeTag) removeTags.push(originalByLower.get(lc(rule.tag)));
      }
      for (const rule of rules.filter((r) => r.type === 'Redeem')) {
        if (!lowerTags.has(lc(rule.tag))) continue;
        changes.push({ delta: -rule.points, strict: true, reason: rule.description || `Redeemed "${rule.tag}"`, source: 'redeem' });
        removeTags.push(originalByLower.get(lc(rule.tag))); // always clear so it can be used again
      }
      return { changes, removeTags };
    })();
  }

  async function processEvent(evt, rawBody, webhookId) {
    const loc = evt.locationId;
    const install = await ghl.loadInstall(loc);
    if (!install || install.status === 'uninstalled') return { status: 'not_installed' };

    if (!evt.contactId) return { status: 'ignored', reason: 'no contact id' };

    const eventKey = webhookId || sha1(rawBody || JSON.stringify(evt));
    const first = await store.set(K.event(loc, eventKey), '1', { nx: true, ex: 7 * 86400 });
    if (!first) return { status: 'duplicate' };

    const ctx = { markers: [] };
    try {
      const rules = await tenant.getRules(loc);
      if (!rules.length) return { status: 'no_rules' };

      let changes = [];
      let removeTags = [];

      if (evt.kind === 'invoice') {
        if (evt.status !== 'paid' || !evt.invoiceId) return { status: 'ignored', reason: 'invoice not paid' };
        for (const rule of rules.filter((r) => r.type === 'Purchase')) {
          if (evt.amount < (rule.minAmount || 0)) continue;
          const pts = Math.floor(evt.amount * rule.multiplier);
          if (pts <= 0) continue;
          if (!(await claim(ctx, loc, `inv:${evt.invoiceId}:${rule.id}`))) continue;
          changes.push({ delta: pts, reason: rule.description || `Invoice paid (${evt.amount} ${evt.currency})`, source: 'invoice' });
        }
      } else if (evt.kind === 'appointment') {
        if (!evt.appointmentId) return { status: 'ignored', reason: 'no appointment id' };
        for (const rule of rules.filter((r) => r.type === 'Appointment')) {
          if (rule.status !== evt.status) continue;
          if (!(await claim(ctx, loc, `appt:${evt.appointmentId}:${rule.id}`))) continue;
          changes.push({ delta: rule.points, reason: rule.description || `Appointment ${evt.status}`, source: 'appointment' });
        }
      } else if (evt.kind === 'contact_tags' || evt.kind === 'contact_create') {
        if (evt.kind === 'contact_create') {
          for (const rule of rules.filter((r) => r.type === 'Signup')) {
            if (!(await claim(ctx, loc, `signup:${evt.contactId}:${rule.id}`))) continue;
            changes.push({ delta: rule.points, reason: rule.description || 'Welcome bonus', source: 'signup' });
          }
        }
        if (evt.tags?.length) {
          const t = await tagChanges(rules, evt, ctx, loc);
          changes = changes.concat(t.changes);
          removeTags = t.removeTags;
        }
      }

      if (!changes.length && !removeTags.length) return { status: 'no_matching_rule' };

      const out = await applyToContact(loc, evt.contactId, { changes, removeTags, name: evt.name, ctx });
      return { status: 'processed', balance: out.balance, earned: out.earned, burned: out.burned, crmOk: out.crmOk };
    } catch (e) {
      // roll back claims so a retry of this delivery can succeed
      await undo(ctx);
      await store.del(K.event(loc, eventKey)).catch(() => {});
      throw e;
    }
  }

  // ---------------------------------------------------------------- manual / workflow adjustments
  async function adjust(loc, contactId, delta, { reason = 'Manual adjustment', source = 'manual', idempotencyKey } = {}) {
    const max = config.limits.maxPointsPerAdjust;
    if (!contactId || typeof contactId !== 'string' || contactId.length > 64) throw new tenant.ValidationError('contactId is required');
    delta = Math.trunc(Number(delta));
    if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > max) {
      throw new tenant.ValidationError(`points must be a non-zero whole number up to ${max}`);
    }
    const ctx = { markers: [] };
    if (idempotencyKey) {
      const first = await store.set(K.event(loc, 'idem:' + sha1(String(idempotencyKey))), '1', { nx: true, ex: 7 * 86400 });
      if (!first) return { status: 'duplicate' };
    }
    try {
      const out = await applyToContact(loc, contactId, {
        changes: [{ delta, strict: delta < 0, reason: String(reason).slice(0, 140), source }],
        ctx
      });
      const r = out.results[0];
      if (!r.ok) return { status: 'insufficient_points', balance: out.balance };
      return { status: 'processed', balance: out.balance, applied: r.applied, crmOk: out.crmOk };
    } catch (e) {
      await undo(ctx);
      if (idempotencyKey) await store.del(K.event(loc, 'idem:' + sha1(String(idempotencyKey)))).catch(() => {});
      throw e;
    }
  }

  async function getBalance(loc, contactId) {
    return (await store.zscore(K.balances(loc), contactId)) ?? 0;
  }

  async function overview(loc) {
    const [stats, members] = await Promise.all([store.hgetall(K.stats(loc)), store.zcard(K.balances(loc))]);
    return {
      earned: parseInt(stats.earned, 10) || 0,
      burned: parseInt(stats.burned, 10) || 0,
      events: parseInt(stats.events, 10) || 0,
      members: Number(members) || 0
    };
  }

  async function leaderboard(loc, limit = 10) {
    const top = await store.zrevrange(K.balances(loc), limit);
    const names = await store.hgetall(K.names(loc));
    const rows = [];
    for (const { member, score } of top) {
      let name = names[member];
      if (!name) {
        try {
          const c = await ghl.getContact(loc, member);
          name = c?.contactName || [c?.firstName, c?.lastName].filter(Boolean).join(' ') || '';
          if (name) await rememberName(loc, member, name);
        } catch {
          name = '';
        }
      }
      rows.push({ contactId: member, name: name || 'Unknown contact', points: score });
    }
    return rows;
  }

  async function activity(loc, limit = 50) {
    const raw = await store.lrange(K.activity(loc), 0, Math.min(limit, config.limits.activityKeep) - 1);
    return raw.map((r) => {
      try {
        return JSON.parse(r);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  /** Push balances for contacts whose CRM sync failed earlier. */
  async function resyncDirty(loc) {
    const settings = await tenant.getSettings(loc);
    const ids = (await store.smembers(K.dirty(loc))).slice(0, 50);
    let fixed = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        if (settings?.fieldId) await ghl.setContactField(loc, id, settings.fieldId, (await store.zscore(K.balances(loc), id)) ?? 0);
        await store.srem(K.dirty(loc), id);
        fixed++;
      } catch {
        failed++;
      }
    }
    return { fixed, failed, remaining: (await store.smembers(K.dirty(loc))).length };
  }

  return { processEvent, adjust, getBalance, overview, leaderboard, activity, resyncDirty };
}

module.exports = { createEngine, normalize };
