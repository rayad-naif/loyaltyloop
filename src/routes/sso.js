'use strict';

const express = require('express');
const config = require('../config');
const ghl = require('../ghl');
const tenant = require('../tenant');
const store = require('../store');
const { K } = store;
const { ssoDecrypt, signSession } = require('../crypto');
const { wrap, rateLimit } = require('../middleware');

const router = express.Router();

/**
 * POST /sso/session { key }
 * `key` is the encrypted user-context blob HighLevel posts to the iframe
 * (REQUEST_USER_DATA_RESPONSE). We decrypt it with the app's Shared Secret, check
 * the location is installed, and hand back a short-lived signed session token.
 * The browser never gets to choose its own locationId.
 */
router.post(
  '/sso/session',
  rateLimit({ windowMs: 60000, max: 30 }),
  wrap(async (req, res) => {
    const { key, devLocationId } = req.body || {};
    let ctx;

    if (config.security.devBypass && devLocationId) {
      ctx = { activeLocation: String(devLocationId), userId: 'dev', userName: 'Developer', role: 'admin', type: 'location' };
    } else {
      if (!key || typeof key !== 'string' || key.length > 8192) {
        return res.status(400).json({ success: false, error: 'bad_request', message: 'Missing SSO payload.' });
      }
      if (!config.ghl.sharedSecret) {
        return res.status(500).json({ success: false, error: 'not_configured', message: 'GHL_SHARED_SECRET is not set on the server.' });
      }
      try {
        ctx = ssoDecrypt(key, config.ghl.sharedSecret);
      } catch {
        return res.status(400).json({ success: false, error: 'bad_payload', message: 'Could not verify the HighLevel session.' });
      }
    }

    // `activeLocation` is the sub-account the user has open. Agency-level users without one must pick a sub-account first.
    const locationId = ctx.activeLocation || ctx.locationId;
    if (!locationId) {
      return res.status(409).json({
        success: false,
        error: 'no_location',
        message: 'Open LoyaltyLoop from inside a sub-account (not the agency view).'
      });
    }

    let install = await ghl.loadInstall(locationId);
    if ((!install || install.status === 'uninstalled') && ctx.companyId) {
      install = await ghl.installLocationViaCompany(String(ctx.companyId), String(locationId));
    }
    if (!install) {
      return res.status(403).json({
        success: false,
        error: 'not_installed',
        message: 'LoyaltyLoop is not installed for this sub-account. Ask your agency admin to install it.'
      });
    }

    const settings = await tenant.getSettings(locationId);
    if (!settings || !settings.fieldId) await tenant.ensureLocation(locationId);

    const token = signSession({
      loc: String(locationId),
      cid: ctx.companyId ? String(ctx.companyId) : install.companyId || null,
      uid: ctx.userId ? String(ctx.userId) : null
    });
    res.json({
      success: true,
      token,
      expiresIn: config.security.sessionTtlSec,
      locationId,
      user: { name: ctx.userName || '', email: ctx.email || '', role: ctx.role || '' }
    });
  })
);

module.exports = router;
