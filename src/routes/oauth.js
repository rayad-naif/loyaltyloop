'use strict';

const express = require('express');
const config = require('../config');
const ghl = require('../ghl');
const tenant = require('../tenant');
const { wrap, messagePage, esc, rateLimit } = require('../middleware');

const router = express.Router();
const g = config.ghl;

function installUrl() {
  if (g.installUrl) return g.installUrl; // paste the "Install link" from your Marketplace app
  const u = new URL('https://marketplace.gohighlevel.com/oauth/chooselocation');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', g.redirectUri);
  u.searchParams.set('client_id', g.clientId);
  u.searchParams.set('scope', g.scopes);
  if (g.versionId) u.searchParams.set('version_id', g.versionId);
  return u.toString();
}

router.get('/install', (req, res) => {
  if (!g.installUrl && !g.clientId) {
    return res.status(503).send(
      messagePage({
        title: 'Not configured',
        heading: 'Install link not configured',
        body: '<p>The server is missing <code>GHL_CLIENT_ID</code> (or <code>GHL_INSTALL_URL</code>).</p>',
        tone: 'err'
      })
    );
  }
  res.redirect(302, installUrl());
});

router.get(
  '/oauth/callback/lc',
  rateLimit({ windowMs: 60000, max: 30 }),
  wrap(async (req, res) => {
    const { code, error, error_description: desc } = req.query;
    if (error) {
      return res.status(400).send(
        messagePage({ title: 'Install cancelled', heading: 'Install was not completed', body: `<p>${esc(desc || error)}</p>`, tone: 'err' })
      );
    }
    if (!code || typeof code !== 'string') {
      return res.status(400).send(messagePage({ title: 'Error', heading: 'Missing authorization code', body: '<p>Please start the install again.</p>', tone: 'err' }));
    }
    if (!g.clientId || !g.clientSecret) {
      return res.status(500).send(messagePage({ title: 'Not configured', heading: 'Server not configured', body: '<p>Missing client credentials.</p>', tone: 'err' }));
    }

    let data;
    try {
      data = await ghl.exchangeAuthCode(code);
    } catch (e) {
      console.error('[oauth] token exchange failed:', e.response?.data || e.message);
      return res.status(400).send(
        messagePage({
          title: 'Install failed',
          heading: 'We could not complete the install',
          body: '<p>LeadConnector rejected the authorization code (it may have expired). Please start the install again.</p>',
          tone: 'err',
          actions: '<p><a class="btn" href="/install">Try again</a></p>'
        })
      );
    }

    const installed = [];
    if (data.userType === 'Location' && data.locationId) {
      await ghl.saveLocationInstall(data);
      installed.push(data.locationId);
    } else if (data.userType === 'Company' && data.companyId) {
      await ghl.saveCompanyInstall(data);
      let ids = ghl.idsFrom(data.approvedLocations);
      if (!ids.length) ids = await ghl.listCompanyLocations(data.access_token, data.companyId);
      for (const id of ids) {
        const rec = await ghl.installLocationViaCompany(data.companyId, id);
        if (rec) installed.push(id);
      }
    } else {
      console.error('[oauth] unexpected token response shape:', Object.keys(data));
      return res.status(400).send(messagePage({ title: 'Error', heading: 'Unexpected response from LeadConnector', body: '<p>Please try again.</p>', tone: 'err' }));
    }

    // Bootstrap a few locations now; the rest bootstrap lazily on first open (see /sso/session).
    for (const id of installed.slice(0, 5)) {
      try {
        await tenant.ensureLocation(id);
      } catch (e) {
        console.error(`[oauth] bootstrap failed for ${id}:`, e.ghlMessage || e.message);
      }
    }

    const n = installed.length;
    const body =
      n > 0
        ? `<p>Connected to <strong>${n}</strong> location${n === 1 ? '' : 's'}. Open <strong>LoyaltyLoop</strong> from the left menu inside your CRM to set up your rules.</p>`
        : `<p>Your install is saved, but no locations were found yet. Open LoyaltyLoop from your CRM account and it will finish connecting automatically.</p>`;
    res.send(
      messagePage({
        title: 'Installed',
        heading: 'LoyaltyLoop is installed',
        body,
        actions: '<p><a class="btn" href="/docs">Read the setup guide</a></p>'
      })
    );
  })
);

module.exports = router;
