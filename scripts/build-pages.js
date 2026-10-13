'use strict';

/**
 * Generates the static marketing/legal/docs pages into /public so they can be
 * served by any static host without a build step. Edit the content below, then
 *   npm run build:pages
 * The generated HTML is committed, so deployments do not need to run this.
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public');
const COMPANY = 'IR Official';
const EMAIL = 'idylle_radieuse@outlook.com';
const UPDATED = 'October 14, 2026';

const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  logo: svg('<path d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.133-8-12.739-8-4.585 0-4.585 8 0 8 5.606 0 7.644-8 12.74-8z"/>'),
  sliders: svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
  gift: svg('<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v9H5v-9M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>'),
  crown: svg('<path d="M2 20h20M4 17 2 6l6 5 4-7 4 7 6-5-2 11z"/>'),
  shield: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>'),
  bolt: svg('<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>'),
  user: svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>')
};

const NAV = [
  ['/', 'Overview'],
  ['/docs', 'Docs'],
  ['/support', 'Support'],
  ['/privacy', 'Privacy'],
  ['/terms', 'Terms']
];

function layout({ file, title, description, body, active }) {
  const nav = NAV.map(([href, label]) => `<a href="${href}"${href === active ? ' class="active"' : ''}>${label}</a>`).join('');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>
<header class="nav"><div class="wrap">
  <a class="brand" href="/"><span class="logo">${ICONS.logo}</span>LoyaltyLoop</a>
  <nav class="nav-links">${nav}<a class="btn" href="/install">Install app</a></nav>
</div></header>
${body}
<footer><div class="wrap">
  <div>© 2026 ${COMPANY}. LoyaltyLoop is a product of ${COMPANY}.</div>
  <nav><a href="/docs">Documentation</a><a href="/support">Support</a><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a><a href="mailto:${EMAIL}">${EMAIL}</a></nav>
</div></footer>
</body>
</html>
`;
  fs.writeFileSync(path.join(OUT, file), html);
  console.log('wrote', file);
}

const card = (icon, cls, h, p) => `<div class="card"><div class="ico ${cls}">${ICONS[icon]}</div><h3>${h}</h3><p>${p}</p></div>`;

// ------------------------------------------------------------------ HOME
layout({
  file: 'index.html',
  active: '/',
  title: 'LoyaltyLoop - Gamified loyalty points for your CRM',
  description: 'LoyaltyLoop rewards your customers with points for paid invoices, attended appointments, tags and more, directly inside your CRM.',
  body: `
<section class="hero"><div class="wrap">
  <span class="pill">Loyalty &amp; rewards engine for your CRM</span>
  <h1>Loyalty points that<br><span>run themselves</span></h1>
  <p class="lead">Reward customers for paying invoices, showing up to appointments and the actions you choose. Points land on the contact record automatically, ready for your workflows.</p>
  <div class="cta"><a class="btn lg" href="/install">Install LoyaltyLoop</a><a class="btn lg ghost" href="/docs">Read the docs</a></div>
</div></section>

<section class="block"><div class="wrap">
  <h2 class="h2">Up and running in three steps</h2>
  <p class="sub">No code, no spreadsheets. Everything is configured from inside your CRM.</p>
  <div class="steps">
    <div class="step"><div><h4>Install from the App Marketplace</h4><p>Install LoyaltyLoop on your agency or a single sub-account. We create a <em>Loyalty Points Balance</em> field on your contacts for you.</p></div></div>
    <div class="step"><div><h4>Choose how customers earn and redeem</h4><p>Pick from ready-made rules: points per dollar, review bonuses, appointment attendance, welcome bonuses and tag-based redemptions.</p></div></div>
    <div class="step"><div><h4>Let it run</h4><p>Points are added the moment a customer pays or attends. Use the balance and VIP tags in your workflows, emails and smart lists.</p></div></div>
  </div>
</div></section>

<section class="block alt"><div class="wrap">
  <h2 class="h2">Everything you need for a rewards programme</h2>
  <p class="sub">Built for agencies and local businesses that run on LeadConnector.</p>
  <div class="grid g3">
    ${card('sliders', '', 'Flexible earn rules', 'Award points for paid invoices (any rate), appointment status, new contacts, or whenever a tag is applied.')}
    ${card('gift', 'g', 'Simple redemption', 'Add a tag like <code>redeem_coffee</code> and LoyaltyLoop deducts the points, removes the tag, and refuses if the balance is too low.')}
    ${card('crown', 'p', 'Automatic VIP tiers', 'Tag contacts the moment they cross a points threshold, then trigger premium follow-ups from your workflows.')}
    ${card('user', 'a', 'Balance on every contact', 'The points total is written to a custom field, so it works with merge fields, filters and conditions everywhere in the CRM.')}
    ${card('bolt', '', 'Workflow webhook', 'Award or deduct points from any automation with one webhook action, with built-in protection against duplicates.')}
    ${card('shield', 'g', 'Isolated per location', 'Each sub-account has its own rules, balances and history. Nothing is shared between locations.')}
  </div>
</div></section>

<section class="block"><div class="wrap" style="text-align:center">
  <h2 class="h2">Ready to reward your best customers?</h2>
  <p class="sub">Install in under a minute. Uninstalling removes all data we hold for your account.</p>
  <a class="btn lg" href="/install">Install LoyaltyLoop</a>
</div></section>`
});

// ------------------------------------------------------------------ DOCS
layout({
  file: 'docs.html',
  active: '/docs',
  title: 'Documentation - LoyaltyLoop',
  description: 'Setup guide and reference for LoyaltyLoop: rules, redemption, VIP tiers, the workflow webhook and troubleshooting.',
  body: `
<main class="page"><div class="wrap"><article class="prose">
<h1>Documentation</h1>
<p class="meta">Everything you need to set up and run LoyaltyLoop in your CRM.</p>
<div class="toc"><strong>On this page</strong>
<a href="#install">1. Installing</a><a href="#open">2. Opening the app</a><a href="#rules">3. Earn and redeem rules</a><a href="#redeem">4. Redeeming points</a>
<a href="#tiers">5. VIP tiers</a><a href="#field">6. Using the points balance</a><a href="#webhook">7. Workflow webhook</a><a href="#notes">8. Good to know</a><a href="#troubleshooting">9. Troubleshooting</a></div>

<h2 id="install">1. Installing</h2>
<p>Install LoyaltyLoop from the LeadConnector App Marketplace, or use the <a href="/install">install link</a>. You can install on:</p>
<ul>
<li><strong>A single sub-account</strong> - LoyaltyLoop is connected to that location only.</li>
<li><strong>Your agency (bulk install)</strong> - choose which sub-accounts to enable. Each one gets its own independent rules, balances and history.</li>
</ul>
<p>During install LoyaltyLoop creates a contact custom field called <strong>Loyalty Points Balance</strong> (field key <code>contact.loyalty_points_balance</code>) and a starter set of rules you can edit or delete.</p>

<h2 id="open">2. Opening the app</h2>
<p>Inside a sub-account, click <strong>LoyaltyLoop</strong> in the left-hand menu. You will be signed in automatically using your CRM session. If you open the app from the agency view you will be asked to choose a sub-account first.</p>
<p>The dashboard has five tabs: <strong>Overview</strong> (totals and top members), <strong>Rules</strong>, <strong>Members</strong> (search and adjust balances), <strong>Activity</strong> (every points change) and <strong>Settings</strong> (VIP tiers and the workflow webhook).</p>

<h2 id="rules">3. Earn and redeem rules</h2>
<table>
<tr><th>Rule</th><th>When it fires</th><th>Details</th></tr>
<tr><td><strong>Invoice paid</strong></td><td>An invoice is fully paid</td><td>Points = amount paid × multiplier, rounded down. Optional minimum invoice amount. Paid once per invoice.</td></tr>
<tr><td><strong>Contact tagged (earn)</strong></td><td>A contact has the tag</td><td>Fixed points. Paid once per contact, or repeatable if you enable "remove the tag after awarding".</td></tr>
<tr><td><strong>Appointment status</strong></td><td>An appointment becomes <em>Showed</em> or <em>Confirmed</em></td><td>Fixed points. Paid once per appointment.</td></tr>
<tr><td><strong>New contact</strong></td><td>A contact is created</td><td>A welcome bonus, paid once per contact.</td></tr>
<tr><td><strong>Contact tagged (redeem)</strong></td><td>A contact has the tag</td><td>Deducts points and removes the tag. See below.</td></tr>
</table>
<p>Rules are saved per sub-account. Remember to click <strong>Save changes</strong> after editing.</p>

<h2 id="redeem">4. Redeeming points</h2>
<p>Create a <em>Contact tagged (redeem)</em> rule, for example tag <code>redeem_coffee</code> costing 500 points. When a staff member or workflow adds that tag to a contact:</p>
<ol>
<li>If the contact has enough points, the cost is deducted and the new balance is written to their record.</li>
<li>If not, nothing is deducted and the attempt is recorded in <strong>Activity</strong> as "not enough points".</li>
<li>Either way, the tag is removed so it can be used again later.</li>
</ol>

<h2 id="tiers">5. VIP tiers</h2>
<p>In <strong>Settings → VIP tiers</strong>, define a name, a points threshold and a tag. The first time a contact's balance reaches the threshold, LoyaltyLoop adds the tag (default: <code>VIP_Gold</code> at 1,000 points). Use that tag as a workflow trigger to send rewards or move them into a premium pipeline. A tier tag is added once per contact and is not removed if the balance later drops.</p>

<h2 id="field">6. Using the points balance</h2>
<p>The balance is available anywhere custom fields are: the merge field <code>{{contact.loyalty_points_balance}}</code>, smart list filters, and workflow <em>If/Else</em> conditions (for example "Loyalty Points Balance is greater than 200").</p>

<h2 id="webhook">7. Workflow webhook</h2>
<p>To award or deduct points from your own automations, add a <strong>Custom Webhook</strong> action to a workflow:</p>
<ul>
<li>Method: <code>POST</code></li>
<li>URL and API key: shown in <strong>Settings → Workflow webhook</strong> (keep the key private; you can rotate it at any time)</li>
<li>Header: <code>x-api-key: &lt;your key&gt;</code></li>
</ul>
<pre><code>{
  "contactId": "{{contact.id}}",
  "action": "earn",
  "points": 50,
  "reason": "Event attendance",
  "idempotencyKey": "{{contact.id}}-event-2026-10"
}</code></pre>
<table>
<tr><th>Field</th><th>Description</th></tr>
<tr><td><code>contactId</code></td><td>Required. The contact to change.</td></tr>
<tr><td><code>action</code></td><td>Required. <code>earn</code> or <code>burn</code>.</td></tr>
<tr><td><code>points</code></td><td>Required. A positive whole number (up to 1,000,000).</td></tr>
<tr><td><code>reason</code></td><td>Optional. Shown in Activity.</td></tr>
<tr><td><code>idempotencyKey</code></td><td>Optional. If the same key is sent twice only the first request is applied.</td></tr>
</table>
<p>Responses: <code>200</code> with the new balance on success, <code>401</code> for a wrong key, <code>409</code> if a <code>burn</code> would take the balance below zero.</p>

<h2 id="notes">8. Good to know</h2>
<ul>
<li>Balances are kept by LoyaltyLoop and mirrored to the contact field after every change. If a CRM update ever fails, the Overview tab shows a "waiting to sync" notice with a <strong>Sync now</strong> button. Points are never lost.</li>
<li>Editing the points custom field by hand does not change LoyaltyLoop's ledger and will be overwritten on the next change. Use <strong>Members → Adjust</strong> instead.</li>
<li>Refunds and voided invoices do not automatically remove points. Use <strong>Members → Adjust</strong> with a negative number.</li>
<li>If a contact already had a value in the points field when LoyaltyLoop first sees them (for example after a reinstall), that value is used as their starting balance.</li>
<li>Uninstalling LoyaltyLoop deletes the rules, ledger and history we hold for the location. The field values on your contacts remain in your CRM.</li>
</ul>

<h2 id="troubleshooting">9. Troubleshooting</h2>
<table>
<tr><th>Problem</th><th>What to check</th></tr>
<tr><td>Dashboard says "not installed"</td><td>Open the app from inside a sub-account that LoyaltyLoop was installed on. Agency admins can install it for more sub-accounts from the App Marketplace.</td></tr>
<tr><td>Points are not being added</td><td>Check the rule exists and was saved. Invoices must be <em>fully paid</em>. For tag rules, the tag must match exactly (not case-sensitive). Look in <strong>Activity</strong> for the event.</td></tr>
<tr><td>Overview shows "Points field is missing"</td><td>Click <strong>Create field</strong>. If it keeps failing, confirm the app has permission to manage custom fields, or reinstall.</td></tr>
<tr><td>The same tag keeps awarding points</td><td>Tag rules pay once per contact unless "remove the tag after awarding" is enabled for that rule.</td></tr>
<tr><td>Session expired</td><td>Reload the page or reopen LoyaltyLoop from the left menu.</td></tr>
</table>
<div class="callout">Still stuck? Email <a href="mailto:${EMAIL}">${EMAIL}</a> with your location name and what you expected to happen.</div>
</article></div></main>`
});

// ------------------------------------------------------------------ SUPPORT
layout({
  file: 'support.html',
  active: '/support',
  title: 'Support - LoyaltyLoop',
  description: 'Get help with LoyaltyLoop. Contact IR Official, read the FAQ, or browse the documentation.',
  body: `
<main class="page"><div class="wrap"><article class="prose">
<h1>Help &amp; Support</h1>
<p class="meta">We're here to help you get the most out of LoyaltyLoop.</p>

<div class="grid g2" style="margin:8px 0 8px">
  <div class="card"><h3 style="margin-top:0">Email support</h3><p><a href="mailto:${EMAIL}">${EMAIL}</a></p><p class="small muted" style="margin-top:8px">${COMPANY}. We aim to reply within two business days. Please include your location name and, if relevant, the contact and time of the event.</p></div>
  <div class="card"><h3 style="margin-top:0">Documentation</h3><p>Step-by-step setup, rule reference and troubleshooting.</p><p style="margin-top:12px"><a class="btn sm" href="/docs">Open the docs</a></p></div>
</div>

<h2>Frequently asked questions</h2>
<h3>How do I install LoyaltyLoop?</h3>
<p>Use the <a href="/install">install link</a> or find LoyaltyLoop in the LeadConnector App Marketplace. Then open it from the left-hand menu of your sub-account.</p>
<h3>Does each sub-account have separate data?</h3>
<p>Yes. Rules, balances, tiers and activity are stored separately for every location. Agency installs let you choose which sub-accounts to enable.</p>
<h3>Where do customers' points appear?</h3>
<p>On the contact record in the <em>Loyalty Points Balance</em> custom field, which you can use in workflows, smart lists and merge fields.</p>
<h3>A customer redeemed a reward but nothing was deducted.</h3>
<p>Open the <strong>Activity</strong> tab. If the entry says "not enough points", the contact's balance was lower than the reward cost. The redeem tag is always removed so it can be used again.</p>
<h3>Can I give or remove points manually?</h3>
<p>Yes: use <strong>Members → Adjust</strong>, or the workflow webhook for automations. See the <a href="/docs#webhook">docs</a>.</p>
<h3>What happens to my data if I uninstall?</h3>
<p>We delete the rules, balances, history and access tokens we hold for the location. Values already written to your contacts' custom fields stay in your CRM. See our <a href="/privacy">Privacy Policy</a>.</p>
<h3>How do I request deletion of data?</h3>
<p>Uninstalling removes it automatically. You can also email <a href="mailto:${EMAIL}">${EMAIL}</a> and we will help.</p>
</article></div></main>`
});

// ------------------------------------------------------------------ PRIVACY
layout({
  file: 'privacy.html',
  active: '/privacy',
  title: 'Privacy Policy - LoyaltyLoop',
  description: 'How LoyaltyLoop by IR Official collects, uses, stores and deletes data.',
  body: `
<main class="page"><div class="wrap"><article class="prose">
<h1>Privacy Policy</h1>
<p class="meta">Effective ${UPDATED} · Operated by ${COMPANY}</p>
<p>LoyaltyLoop ("the App", "we") is a loyalty points application for the LeadConnector platform, provided by ${COMPANY}. This policy explains what data the App handles when you install and use it, and your choices. We do not sell your data and we do not use it for advertising.</p>

<h2>1. Who is who</h2>
<p>When you use LoyaltyLoop, you (the business or agency) are the controller of your customers' data and we act as your processor, handling it only to provide the features you configure. This policy covers our handling of both your account information and the customer data you ask the App to process.</p>

<h2>2. Data we handle</h2>
<table>
<tr><th>Category</th><th>What</th><th>Why</th></tr>
<tr><td>Installation data</td><td>Location ID, company (agency) ID, installing user ID, OAuth access and refresh tokens, granted scopes</td><td>To act on your behalf in your CRM and to keep each location's data separate</td></tr>
<tr><td>Session data</td><td>The user ID, name, email, role and active location LeadConnector provides when you open the App inside your CRM</td><td>To sign you in. We keep only a short-lived signed session token; we do not store your name or email</td></tr>
<tr><td>Configuration</td><td>Your rules, VIP tier settings, the ID of the points custom field, and a workflow webhook key</td><td>To run your loyalty programme</td></tr>
<tr><td>Loyalty ledger</td><td>For each rewarded contact: contact ID, display name (cached to label the dashboard), points balance, and a log of points changes with the reason and time</td><td>To calculate balances and show activity and leaderboards</td></tr>
<tr><td>Event data</td><td>Webhook events from LeadConnector (such as a paid invoice, an appointment status, a tag change). Contents are processed to apply your rules; we keep only a short-lived identifier to prevent the same event being counted twice</td><td>To award points exactly once</td></tr>
</table>
<p>We do not collect payment card details, passwords, or the contents of messages. We do not store contacts' email addresses or phone numbers; these are read live from your CRM only when you search for a member in the dashboard.</p>

<h2>3. Permissions we request</h2>
<p>The App requests access to read and update contacts and their tags, to read and create contact custom fields, to read invoices and calendar events (to detect paid invoices and appointment status), and to read locations and generate location access tokens. We use each permission only for the purpose described above.</p>

<h2>4. How we use data</h2>
<ul>
<li>To award, deduct and display loyalty points according to your rules.</li>
<li>To write the points balance and VIP tags back to your contacts.</li>
<li>To secure the service, prevent abuse and troubleshoot errors.</li>
</ul>

<h2>5. Storage and security</h2>
<ul>
<li>OAuth tokens are encrypted at rest (AES-256-GCM). All traffic uses HTTPS.</li>
<li>Webhook requests from LeadConnector are verified using LeadConnector's digital signature before they are processed.</li>
<li>Each location's data is stored under that location's own keys. Dashboard sessions are bound to a single location and cannot read another's data.</li>
<li>Data is hosted with our infrastructure providers (application hosting and a managed Redis database) who process it only to provide hosting.</li>
</ul>

<h2>6. Sharing</h2>
<p>We do not sell, rent or share your data. We share it only with the infrastructure providers described above, with LeadConnector (because the App operates through its API), or if required by law.</p>

<h2>7. Retention and deletion</h2>
<p>We keep data while the App is installed. When you uninstall, we delete the tokens, rules, settings, balances, activity log and cached names we hold for the location. Points values already written to your contacts' custom fields remain in your CRM, which you control. Short-lived event identifiers expire automatically within seven days. You can also request deletion at any time at <a href="mailto:${EMAIL}">${EMAIL}</a>.</p>

<h2>8. Your rights</h2>
<p>Depending on where you or your customers live, you may have rights to access, correct, delete or export personal data. Because we act on your behalf, please direct requests from your customers to your business; we will assist you in fulfilling them. Contact us at <a href="mailto:${EMAIL}">${EMAIL}</a>.</p>

<h2>9. Children</h2>
<p>The App is intended for businesses and is not directed at children.</p>

<h2>10. Changes</h2>
<p>We may update this policy and will change the effective date above when we do. Material changes will be communicated through the App or by email.</p>

<h2>11. Contact</h2>
<p>${COMPANY}<br>Email: <a href="mailto:${EMAIL}">${EMAIL}</a></p>
</article></div></main>`
});

// ------------------------------------------------------------------ TERMS
layout({
  file: 'terms.html',
  active: '/terms',
  title: 'Terms of Service - LoyaltyLoop',
  description: 'The terms that govern your use of LoyaltyLoop by IR Official.',
  body: `
<main class="page"><div class="wrap"><article class="prose">
<h1>Terms of Service</h1>
<p class="meta">Effective ${UPDATED} · ${COMPANY}</p>
<p>These Terms govern your use of LoyaltyLoop (the "App"), provided by ${COMPANY} ("we", "us"). By installing or using the App you agree to these Terms. If you accept them on behalf of a business or agency, you confirm you have authority to do so.</p>

<h2>1. The service</h2>
<p>LoyaltyLoop lets you define rules that award and redeem loyalty points for your contacts inside your CRM account, and writes balances and tags back to those contacts. The App works through LeadConnector's APIs and requires an active LeadConnector account.</p>

<h2>2. Installation and accounts</h2>
<p>You are responsible for the sub-accounts you install the App on, for the people you allow to use it, and for keeping your CRM credentials secure. Workflow webhook keys shown in the App are confidential; rotate a key if you believe it has been exposed.</p>

<h2>3. Your responsibilities</h2>
<ul>
<li>You decide the rules and rewards. You are responsible for honouring any rewards you promise customers and for complying with laws that apply to loyalty, promotions, marketing and consumer protection in your jurisdiction.</li>
<li>Loyalty points are a record kept for your programme. They have no cash value and are not a payment instrument unless you choose to make them redeemable for something of value under your own terms.</li>
<li>You are responsible for having a lawful basis to process your customers' data and for giving them any required notices.</li>
</ul>

<h2>4. Acceptable use</h2>
<p>You will not: use the App unlawfully; attempt to access another location's data; interfere with or overload the service; reverse engineer it except as the law allows; or use it to send spam or deceptive offers.</p>

<h2>5. Data and privacy</h2>
<p>Our <a href="/privacy">Privacy Policy</a> explains how data is handled and forms part of these Terms. You keep ownership of your data. When you uninstall, we delete the data we hold for the location as described in the policy.</p>

<h2>6. Availability and changes</h2>
<p>We work to keep the App available but do not guarantee uninterrupted service; it depends on third-party platforms including LeadConnector. We may modify or discontinue features, and will give reasonable notice of material changes.</p>

<h2>7. Fees</h2>
<p>Pricing, where applicable, is shown in the LeadConnector App Marketplace listing and is billed through the Marketplace.</p>

<h2>8. Disclaimer</h2>
<p>The App is provided "as is" and "as available". To the maximum extent permitted by law, we disclaim all warranties, including merchantability, fitness for a particular purpose and non-infringement. You are responsible for reviewing your rules and balances; automated rules can award points you did not intend if configured incorrectly.</p>

<h2>9. Limitation of liability</h2>
<p>To the maximum extent permitted by law, ${COMPANY} will not be liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue or data, arising from your use of the App. Our total liability for any claim relating to the App is limited to the amount you paid for it in the twelve months before the claim arose.</p>

<h2>10. Termination</h2>
<p>You may stop using the App at any time by uninstalling it. We may suspend or end access if you breach these Terms or if required by law or by LeadConnector's platform rules.</p>

<h2>11. Changes to these Terms</h2>
<p>We may update these Terms and will change the effective date when we do. Continued use after an update means you accept the new Terms.</p>

<h2>12. Governing law</h2>
<p>These Terms are governed by the laws applicable in the jurisdiction where ${COMPANY} is established, without regard to conflict-of-law rules.</p>

<h2>13. Contact</h2>
<p>${COMPANY} · <a href="mailto:${EMAIL}">${EMAIL}</a></p>
</article></div></main>`
});

// ------------------------------------------------------------------ 404
layout({
  file: '404.html',
  active: '',
  title: 'Page not found - LoyaltyLoop',
  description: 'Page not found',
  body: `
<main class="page"><div class="wrap"><article class="prose" style="text-align:center;padding:60px 0">
<h1>Page not found</h1>
<p>The page you are looking for does not exist.</p>
<p><a class="btn" href="/">Back to home</a></p>
</article></div></main>`
});
