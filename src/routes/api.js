'use strict';

/**
 * Dashboard API. Every route is scoped to the location inside the session token;
 * there is no locationId in any URL, so one sub-account can never read another's data.
 */

const express = require('express');
const config = require('../config');
const store = require('../store');
const { K } = store;
const ghl = require('../ghl');
const tenant = require('../tenant');
const { createEngine } = require('../points');
const { wrap, rateLimit, requireSession } = require('../middleware');

const router = express.Router();
const engine = createEngine();

router.use(rateLimit({ windowMs: 60000, max: 240, keyFn: (req) => (req.headers.authorization || req.ip).slice(-40) }));
router.use(requireSession);

router.get(
  '/overview',
  wrap(async (req, res) => {
    const loc = req.locationId;
    const [settings, rules, stats, dirty] = await Promise.all([
      tenant.getSettings(loc),
      tenant.getRules(loc),
      engine.overview(loc),
      store.smembers(K.dirty(loc))
    ]);
    res.json({
      success: true,
      locationId: loc,
      field: { id: settings?.fieldId || null, key: settings?.fieldKey || ghl.FIELD_KEY, error: settings?.fieldError || null },
      stats,
      rulesCount: rules.length,
      tiers: settings?.tiers || [],
      pendingSync: dirty.length,
      workflow: { url: `${config.baseUrl}/webhook/workflow/${loc}`, key: settings?.webhookKey || null },
      persistent: store.isPersistent()
    });
  })
);

router.get('/rules', wrap(async (req, res) => res.json({ success: true, rules: await tenant.getRules(req.locationId) })));

router.put(
  '/rules',
  wrap(async (req, res) => {
    const rules = await tenant.saveRules(req.locationId, req.body?.rules);
    res.json({ success: true, rules });
  })
);

router.put(
  '/tiers',
  wrap(async (req, res) => {
    const s = await tenant.updateTiers(req.locationId, req.body?.tiers);
    res.json({ success: true, tiers: s.tiers });
  })
);

router.get('/leaderboard', wrap(async (req, res) => res.json({ success: true, rows: await engine.leaderboard(req.locationId, 10) })));

router.get(
  '/activity',
  wrap(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), config.limits.activityKeep);
    res.json({ success: true, items: await engine.activity(req.locationId, limit) });
  })
);

router.get(
  '/contacts/search',
  wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q.length < 2) return res.json({ success: true, contacts: [] });
    const contacts = await ghl.searchContacts(req.locationId, q, 10);
    for (const c of contacts) c.points = await engine.getBalance(req.locationId, c.id);
    res.json({ success: true, contacts });
  })
);

router.post(
  '/contacts/:contactId/adjust',
  rateLimit({ windowMs: 60000, max: 60, keyFn: (req) => 'adj:' + req.locationId }),
  wrap(async (req, res) => {
    const { points, reason } = req.body || {};
    const out = await engine.adjust(req.locationId, req.params.contactId, points, {
      reason: reason ? `Manual: ${String(reason).slice(0, 120)}` : 'Manual adjustment',
      source: 'dashboard'
    });
    if (out.status === 'insufficient_points') {
      return res.status(409).json({ success: false, error: 'insufficient_points', message: `Contact only has ${out.balance} points.`, balance: out.balance });
    }
    res.json({ success: true, ...out });
  })
);

router.post(
  '/field/repair',
  wrap(async (req, res) => {
    const s = await tenant.ensureField(req.locationId);
    if (!s.fieldId) return res.status(502).json({ success: false, error: 'field_failed', message: s.fieldError || 'Could not create the custom field.' });
    res.json({ success: true, field: { id: s.fieldId, key: s.fieldKey } });
  })
);

router.post(
  '/webhook-key/rotate',
  wrap(async (req, res) => {
    const s = await tenant.rotateWebhookKey(req.locationId);
    res.json({ success: true, key: s.webhookKey });
  })
);

router.post('/resync', wrap(async (req, res) => res.json({ success: true, ...(await engine.resyncDirty(req.locationId)) })));

router.use((req, res) => res.status(404).json({ success: false, error: 'not_found', message: 'Unknown API route.' }));

module.exports = router;
