'use strict';

const express = require('express');
const store = require('../store');
const { K } = store;
const ghl = require('../ghl');
const tenant = require('../tenant');
const { createEngine, normalize } = require('../points');
const { verifyWebhookSignature, safeEqual } = require('../crypto');
const { wrap, rateLimit } = require('../middleware');

const router = express.Router();
const engine = createEngine();

async function onInstall(evt) {
  // Bulk / "future locations" installs arrive as an event; mint the location token from the agency token.
  if (!evt.locationId || !evt.companyId) return { status: 'ignored' };
  const existing = await ghl.loadInstall(evt.locationId);
  if (existing && existing.status === 'active') return { status: 'already_installed' };
  const rec = await ghl.installLocationViaCompany(String(evt.companyId), String(evt.locationId));
  if (!rec) return { status: 'no_company_token' };
  await tenant.ensureLocation(evt.locationId);
  return { status: 'installed' };
}

async function onUninstall(evt) {
  // Privacy: deleting the install deletes everything we hold for that location.
  // Balances stay in the CRM's own custom field, and re-seed our ledger if the app is reinstalled.
  if (evt.locationId) {
    await tenant.deleteLocationData(evt.locationId);
    return { status: 'location_removed' };
  }
  if (evt.companyId) {
    let removed = 0;
    for (const loc of await store.smembers(K.locations())) {
      const rec = await ghl.loadInstall(loc);
      if (rec && rec.companyId === evt.companyId) {
        await tenant.deleteLocationData(loc);
        removed++;
      }
    }
    await store.del(K.company(evt.companyId));
    return { status: 'company_removed', locations: removed };
  }
  return { status: 'ignored' };
}

/** Native HighLevel app webhooks (signed). Configure this URL in Marketplace -> App -> Advanced Settings -> Webhooks. */
const nativeHandler = wrap(async (req, res) => {
  const sig = verifyWebhookSignature(req.headers, req.rawBody);
  if (!sig.ok) {
    console.warn('[webhook] rejected:', sig.reason);
    return res.status(401).json({ success: false, error: 'invalid_signature' });
  }
  const evt = normalize(req.body);
  if (!evt) return res.status(200).json({ status: 'ignored' });

  let out;
  if (evt.kind === 'install') out = await onInstall(evt);
  else if (evt.kind === 'uninstall') out = await onUninstall(evt);
  else if (evt.kind === 'ignored') out = { status: 'ignored' };
  else out = await engine.processEvent(evt, req.rawBody ? req.rawBody.toString('utf8') : '', req.body?.webhookId);

  res.status(200).json(out);
});

router.post('/webhook/leadconnector', rateLimit({ windowMs: 1000, max: 100, keyFn: () => 'native' }), nativeHandler);
router.post('/webhook/leadconnector-events', rateLimit({ windowMs: 1000, max: 100, keyFn: () => 'native' }), nativeHandler); // legacy path

/**
 * Workflow webhook for "Custom Webhook" actions inside a sub-account's workflows.
 * Authenticated by the per-location key shown in the dashboard.
 *   POST /webhook/workflow/:locationId
 *   headers: x-api-key: <key>      body: { "contactId": "{{contact.id}}", "action": "earn"|"burn", "points": 50, "reason": "...", "idempotencyKey": "..." }
 */
router.post(
  '/webhook/workflow/:locationId',
  rateLimit({ windowMs: 60000, max: 120, keyFn: (req) => 'wf:' + req.params.locationId }),
  wrap(async (req, res) => {
    const loc = req.params.locationId;
    const settings = await tenant.getSettings(loc);
    const provided = req.headers['x-api-key'] || req.body?.key || '';
    if (!settings?.webhookKey || !provided || !safeEqual(provided, settings.webhookKey)) {
      return res.status(401).json({ success: false, error: 'invalid_key' });
    }
    if (!(await store.get(K.install(loc)))) return res.status(403).json({ success: false, error: 'not_installed' });

    const b = req.body || {};
    const action = String(b.action || '').toLowerCase();
    if (!['earn', 'burn'].includes(action)) {
      return res.status(400).json({ success: false, error: 'bad_action', message: 'action must be "earn" or "burn"' });
    }
    const pts = Math.abs(Math.trunc(Number(b.points)));
    const out = await engine.adjust(loc, String(b.contactId || b.contact_id || ''), action === 'earn' ? pts : -pts, {
      reason: b.reason ? `Workflow: ${String(b.reason).slice(0, 120)}` : 'Workflow',
      source: 'workflow',
      idempotencyKey: b.idempotencyKey
    });
    res.status(out.status === 'insufficient_points' ? 409 : 200).json({ success: out.status !== 'insufficient_points', ...out });
  })
);

module.exports = router;
