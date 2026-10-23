/* LoyaltyLoop dashboard. No inline scripts / innerHTML with data: everything user-controlled goes through textContent. */
(function () {
  'use strict';

  const root = document.getElementById('root');
  const dlg = document.getElementById('dlg');
  const toastEl = document.getElementById('toast');
  const S = { token: null, user: null, overview: null, rules: [], rulesDirty: false, tab: 'overview' };

  // ---------------------------------------------------------------- tiny DOM helper
  function h(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  }
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };
  const fmt = (n) => Number(n || 0).toLocaleString();

  let toastTimer;
  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.className = 'toast'), 3600);
  }

  function gate(title, text, retry) {
    clear(root).append(
      h('div', { class: 'gate' },
        h('div', { class: 'logo', style: 'margin:0 auto' }, '∞'),
        h('h2', { text: title }),
        h('p', { text }),
        retry ? h('p', {}, h('button', { class: 'btn', onclick: boot }, 'Try again')) : null)
    );
  }

  // ---------------------------------------------------------------- auth (CRM SSO handshake)
  function requestUserData() {
    return new Promise((resolve, reject) => {
      if (window === window.top) return reject(new Error('not_embedded'));
      const timer = setTimeout(() => { window.removeEventListener('message', onMsg); reject(new Error('timeout')); }, 8000);
      function onMsg(e) {
        if (e.source !== window.parent || !e.data || e.data.message !== 'REQUEST_USER_DATA_RESPONSE') return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(e.data.payload);
      }
      window.addEventListener('message', onMsg);
      window.parent.postMessage({ message: 'REQUEST_USER_DATA' }, '*');
    });
  }

  async function startSession() {
    const dev = new URLSearchParams(location.search).get('dev');
    let body;
    if (dev) body = { devLocationId: dev };
    else body = { key: await requestUserData() };
    const res = await fetch('/sso/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      const err = new Error(data.message || 'Sign-in failed');
      err.code = data.error;
      throw err;
    }
    S.token = data.token;
    S.user = data.user;
  }

  async function api(path, opts = {}, retried) {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: { Authorization: 'Bearer ' + S.token, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (res.status === 401 && !retried) {
      await startSession(); // token expired -> silently re-handshake once
      return api(path, opts, true);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      const err = new Error(data.message || 'Request failed');
      err.code = data.error;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ---------------------------------------------------------------- shell + tabs
  const TABS = [['overview', 'Overview'], ['rules', 'Rules'], ['members', 'Members'], ['activity', 'Activity'], ['settings', 'Settings']];

  function shell() {
    clear(root);
    root.append(
      h('div', { class: 'top' },
        h('div', {}, h('h1', { text: 'LoyaltyLoop' }), h('div', { class: 'who', text: S.user && S.user.name ? `Signed in as ${S.user.name}` : 'Loyalty points engine' }))),
      h('div', { class: 'tabs', role: 'tablist' },
        TABS.map(([id, label]) => h('button', { class: 'tab', role: 'tab', 'data-tab': id, 'aria-selected': String(id === S.tab), onclick: () => showTab(id) }, label))),
      ...TABS.map(([id]) => h('div', { class: 'panel' + (id === S.tab ? ' on' : ''), id: 'p-' + id }))
    );
    renderTab(S.tab);
  }

  function showTab(id) {
    S.tab = id;
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === id)));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('on', p.id === 'p-' + id));
    renderTab(id);
  }

  async function renderTab(id) {
    const p = document.getElementById('p-' + id);
    if (!p) return;
    clear(p).append(h('div', { class: 'empty' }, h('span', { class: 'spin' })));
    try {
      await ({ overview: tabOverview, rules: tabRules, members: tabMembers, activity: tabActivity, settings: tabSettings }[id])(p);
    } catch (e) {
      clear(p).append(h('div', { class: 'status bad' }, h('span', { class: 'dot' }), h('div', {}, h('strong', { text: 'Could not load this page' }), h('div', { class: 'small', text: e.message }))));
      if (e.code === 'unauthorized' || e.code === 'not_installed') gate('Session ended', e.message, true);
    }
  }

  // ---------------------------------------------------------------- Overview
  async function tabOverview(p) {
    const [ov, lb] = await Promise.all([api('/overview'), api('/leaderboard')]);
    S.overview = ov;
    clear(p);

    if (ov.field.id) p.append(status('ok', 'Engine active', `Balances sync to the contact field ${ov.field.key}.`));
    else p.append(status('bad', 'Points field is missing', ov.field.error || 'The "Loyalty Points Balance" custom field could not be created.',
      h('button', { class: 'btn sm', onclick: async (e) => { e.target.disabled = true; try { await api('/field/repair', { method: 'POST' }); toast('Custom field created'); renderTab('overview'); } catch (er) { toast(er.message, true); e.target.disabled = false; } } }, 'Create field')));
    if (ov.pendingSync > 0) p.append(status('warn', `${ov.pendingSync} contact${ov.pendingSync === 1 ? '' : 's'} waiting to sync to the CRM`, 'Points are safe; the CRM field update failed earlier.',
      h('button', { class: 'btn sm', onclick: async (e) => { e.target.disabled = true; try { const r = await api('/resync', { method: 'POST' }); toast(`Synced ${r.fixed}, ${r.remaining} remaining`); renderTab('overview'); } catch (er) { toast(er.message, true); e.target.disabled = false; } } }, 'Sync now')));
    if (!ov.persistent) p.append(status('warn', 'Storage is not persistent', 'Your server has no Redis configured, so data is lost on restart. See the deployment guide.'));

    p.append(h('div', { class: 'stats' },
      stat('Members', fmt(ov.stats.members)), stat('Points earned', fmt(ov.stats.earned)), stat('Points redeemed', fmt(ov.stats.burned)), stat('Rewarded events', fmt(ov.stats.events))));

    p.append(h('div', { class: 'box' },
      h('div', { class: 'box-h' }, h('h3', { text: 'Top members' })),
      h('div', { class: 'box-b' }, lb.rows.length
        ? h('table', { class: 't' }, h('thead', {}, h('tr', {}, h('th', { text: '#' }), h('th', { text: 'Contact' }), h('th', { class: 'num', style: 'text-align:right', text: 'Points' }))),
          h('tbody', {}, lb.rows.map((r, i) => h('tr', {}, h('td', { text: String(i + 1) }), h('td', { text: r.name }), h('td', { class: 'num', text: fmt(r.points) })))))
        : h('div', { class: 'empty', text: 'No points awarded yet. Add rules, then trigger an event (pay an invoice, add a tag) to see members here.' }))));
  }

  const stat = (k, v) => h('div', { class: 'stat' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v }));
  const status = (tone, title, text, action) =>
    h('div', { class: 'status ' + tone }, h('span', { class: 'dot' }), h('div', { style: 'flex:1' }, h('strong', { text: title }), h('div', { class: 'small muted', text })), action || null);

  // ---------------------------------------------------------------- Rules
  const RULE_META = {
    Purchase: { icon: '🧾', title: 'Invoice paid' },
    TagAdded: { icon: '🏷️', title: 'Earn via tag' },
    Redeem: { icon: '🔥', title: 'Redeem via tag' },
    Appointment: { icon: '📅', title: 'Appointment' },
    Signup: { icon: '👋', title: 'New contact bonus' }
  };

  function ruleDetail(r) {
    switch (r.type) {
      case 'Purchase': return h('span', {}, h('span', { class: 'chip plus', text: `${r.multiplier}x` }), ` point per $1 spent${r.minAmount ? ` (min $${r.minAmount})` : ''}`);
      case 'TagAdded': return h('span', {}, 'Tag ', h('code', { text: r.tag }), ' → ', h('span', { class: 'chip plus', text: `+${fmt(r.points)}` }), r.removeTag ? ' (repeatable)' : ' (once per contact)');
      case 'Redeem': return h('span', {}, 'Tag ', h('code', { text: r.tag }), ' → ', h('span', { class: 'chip minus', text: `-${fmt(r.points)}` }));
      case 'Appointment': return h('span', {}, `Status "${r.status}" → `, h('span', { class: 'chip plus', text: `+${fmt(r.points)}` }));
      case 'Signup': return h('span', {}, 'Contact created → ', h('span', { class: 'chip plus', text: `+${fmt(r.points)}` }));
      default: return '';
    }
  }

  async function tabRules(p) {
    if (!S.rulesDirty) S.rules = (await api('/rules')).rules;
    draw();

    function draw() {
      clear(p);
      const list = h('div', {});
      if (!S.rules.length) list.append(h('div', { class: 'empty', text: 'No rules yet. Add one to start rewarding customers.' }));
      S.rules.forEach((r) => {
        const m = RULE_META[r.type] || { icon: '•', title: r.type };
        list.append(h('div', { class: 'rule' },
          h('div', { class: 'l' }, h('div', { class: 'badge', text: m.icon }), h('div', {}, h('h4', { text: m.title }), h('p', {}, r.description ? r.description : ruleDetail(r)))),
          h('div', { class: 'row', style: 'flex:none;gap:6px' }, h('div', { class: 'small', style: 'text-align:right;flex:none' }, ruleDetail(r)),
            h('button', { class: 'icon-btn', title: 'Delete rule', 'aria-label': 'Delete rule', onclick: () => { S.rules = S.rules.filter((x) => x.id !== r.id); S.rulesDirty = true; draw(); } }, '🗑'))));
      });
      p.append(h('div', { class: 'box' },
        h('div', { class: 'box-h' }, h('h3', { text: 'Earn & redeem rules' }),
          h('div', { class: 'row', style: 'flex:none' },
            h('button', { class: 'btn ghost sm', onclick: () => ruleDialog(draw) }, '+ Add rule'),
            h('button', { class: 'btn sm', id: 'saveRules', disabled: !S.rulesDirty, onclick: save }, S.rulesDirty ? 'Save changes' : 'Saved'))),
        h('div', { class: 'box-b' }, list)));
      p.append(h('div', { class: 'small muted', text: 'Earn rules pay once per invoice / appointment / tag unless marked repeatable. Redeem rules deduct points, clear the tag so it can be used again, and are refused when the contact does not have enough points.' }));
    }

    async function save(e) {
      e.target.disabled = true;
      try {
        S.rules = (await api('/rules', { method: 'PUT', body: { rules: S.rules } })).rules;
        S.rulesDirty = false;
        toast('Rules saved');
        draw();
      } catch (er) { toast(er.message, true); e.target.disabled = false; }
    }
  }

  function ruleDialog(done) {
    const type = h('select', { class: 'in' }, Object.entries(RULE_META).map(([v, m]) => h('option', { value: v, text: { Purchase: 'Invoice paid (earn)', TagAdded: 'Contact tagged (earn)', Appointment: 'Appointment status (earn)', Signup: 'New contact (earn)', Redeem: 'Contact tagged (redeem)' }[v] })));
    const mult = h('input', { class: 'in', type: 'number', value: '1', min: '0.01', step: '0.01' });
    const minAmt = h('input', { class: 'in', type: 'number', value: '0', min: '0', step: '1' });
    const tag = h('input', { class: 'in', type: 'text', placeholder: 'e.g. left_review', maxlength: '60' });
    const pts = h('input', { class: 'in', type: 'number', value: '100', min: '1', step: '1' });
    const status = h('select', { class: 'in' }, h('option', { value: 'showed', text: 'Showed (attended)' }), h('option', { value: 'confirmed', text: 'Confirmed' }));
    const removeTag = h('input', { type: 'checkbox' });
    const desc = h('input', { class: 'in', type: 'text', placeholder: 'Optional label shown in your rules list', maxlength: '140' });

    const g = {
      Purchase: h('div', {}, field('Points per $1 spent', mult), field('Minimum invoice amount (optional)', minAmt)),
      tag: h('div', {}, field('Tag', tag), h('div', { class: 'small muted', id: 'tagHelp' })),
      pts: h('div', {}, field('Points', pts)),
      Appointment: h('div', {}, field('When appointment status becomes', status)),
      repeat: h('label', { class: 'small row', style: 'margin-top:10px' }, h('span', { class: 'fixed' }, removeTag), h('span', { text: 'Repeatable: remove the tag after awarding so it can pay again' }))
    };

    function sync() {
      const t = type.value;
      g.Purchase.hidden = t !== 'Purchase';
      g.tag.hidden = !(t === 'TagAdded' || t === 'Redeem');
      g.pts.hidden = t === 'Purchase';
      g.Appointment.hidden = t !== 'Appointment';
      g.repeat.hidden = t !== 'TagAdded';
      g.tag.querySelector('#tagHelp').textContent = t === 'Redeem' ? 'The tag is removed automatically after points are deducted.' : '';
    }
    type.addEventListener('change', sync);

    clear(dlg).append(
      h('div', { class: 'd-b' }, h('h2', { text: 'New rule' }), field('Trigger', type), g.Purchase, g.tag, g.Appointment, g.pts, g.repeat, field('Label', desc)),
      h('div', { class: 'd-f' },
        h('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'btn', onclick: () => {
          const t = type.value;
          const r = { id: 'new_' + Math.random().toString(36).slice(2, 8), type: t, description: desc.value.trim() };
          if (t === 'Purchase') { r.multiplier = parseFloat(mult.value) || 1; r.minAmount = parseFloat(minAmt.value) || 0; }
          else if (t === 'TagAdded' || t === 'Redeem') { r.tag = tag.value.trim(); if (!r.tag) return toast('Tag is required', true); r.points = parseInt(pts.value, 10) || 0; if (t === 'TagAdded') r.removeTag = removeTag.checked; }
          else if (t === 'Appointment') { r.status = status.value; r.points = parseInt(pts.value, 10) || 0; }
          else { r.points = parseInt(pts.value, 10) || 0; }
          S.rules.push(r); S.rulesDirty = true; dlg.close(); done(); toast('Rule added - click Save changes to apply');
        } }, 'Add rule')));
    sync();
    dlg.showModal();
  }
  const field = (label, input) => h('div', {}, h('label', { class: 'f', text: label }), input);

  // ---------------------------------------------------------------- Members
  async function tabMembers(p) {
    clear(p);
    const q = h('input', { class: 'in', type: 'search', placeholder: 'Search contacts by name, email or phone…', autocomplete: 'off' });
    const out = h('div', {});
    let timer;
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 350); });
    async function run() {
      const term = q.value.trim();
      if (term.length < 2) return clear(out);
      clear(out).append(h('div', { class: 'empty' }, h('span', { class: 'spin' })));
      try {
        const { contacts } = await api('/contacts/search?q=' + encodeURIComponent(term));
        clear(out);
        if (!contacts.length) return out.append(h('div', { class: 'empty', text: 'No contacts found.' }));
        out.append(h('table', { class: 't' }, h('thead', {}, h('tr', {}, h('th', { text: 'Contact' }), h('th', { text: 'Email' }), h('th', { style: 'text-align:right', text: 'Points' }), h('th', {}))),
          h('tbody', {}, contacts.map((c) => h('tr', {}, h('td', { text: c.name }), h('td', { class: 'muted', text: c.email }), h('td', { class: 'num', text: fmt(c.points) }),
            h('td', { style: 'text-align:right' }, h('button', { class: 'btn ghost sm', onclick: () => adjustDialog(c, run) }, 'Adjust')))))));
      } catch (e) { clear(out).append(h('div', { class: 'empty fail', text: e.message })); }
    }
    p.append(h('div', { class: 'box' }, h('div', { class: 'box-h' }, h('h3', { text: 'Find a member' })), h('div', { class: 'box-b' }, q, h('div', { style: 'margin-top:14px' }, out))));
  }

  function adjustDialog(c, done) {
    const pts = h('input', { class: 'in', type: 'number', value: '100', step: '1' });
    const reason = h('input', { class: 'in', type: 'text', placeholder: 'e.g. goodwill bonus', maxlength: '120' });
    clear(dlg).append(
      h('div', { class: 'd-b' }, h('h2', { text: 'Adjust points' }), h('p', { class: 'muted', text: `${c.name} currently has ${fmt(c.points)} points.` }),
        field('Points (use a negative number to deduct)', pts), field('Reason', reason)),
      h('div', { class: 'd-f' }, h('button', { class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'btn', onclick: async (e) => {
          e.target.disabled = true;
          try { const r = await api(`/contacts/${encodeURIComponent(c.id)}/adjust`, { method: 'POST', body: { points: parseInt(pts.value, 10), reason: reason.value } }); toast(`New balance: ${fmt(r.balance)}`); dlg.close(); done(); }
          catch (er) { toast(er.message, true); e.target.disabled = false; }
        } }, 'Apply')));
    dlg.showModal();
  }

  // ---------------------------------------------------------------- Activity
  async function tabActivity(p) {
    const { items } = await api('/activity?limit=100');
    clear(p).append(h('div', { class: 'box' }, h('div', { class: 'box-h' }, h('h3', { text: 'Recent activity' }), h('button', { class: 'btn ghost sm', onclick: () => renderTab('activity') }, 'Refresh')),
      h('div', { class: 'box-b' }, items.length
        ? h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['When', 'Contact', 'Change', 'Balance', 'Reason'].map((x) => h('th', { text: x })))),
          h('tbody', {}, items.map((i) => h('tr', {},
            h('td', { class: 'muted', text: new Date(i.t).toLocaleString() }),
            h('td', { text: i.name || i.contactId }),
            h('td', { class: 'num ' + (i.ok === false ? 'fail' : i.delta >= 0 ? 'pos' : 'neg'), style: 'text-align:left', text: (i.delta > 0 ? '+' : '') + fmt(i.delta) }),
            h('td', { text: fmt(i.balance) }),
            h('td', { class: i.ok === false ? 'fail' : '', text: i.reason || '' })))))
        : h('div', { class: 'empty', text: 'Nothing yet.' }))));
  }

  // ---------------------------------------------------------------- Settings
  async function tabSettings(p) {
    const ov = await api('/overview');
    let tiers = ov.tiers.map((t) => ({ ...t }));
    clear(p);

    const tierBox = h('div', {});
    function drawTiers() {
      clear(tierBox);
      if (!tiers.length) tierBox.append(h('div', { class: 'empty', text: 'No tiers. Add one to tag contacts automatically at a points threshold.' }));
      tiers.forEach((t, i) => {
        tierBox.append(h('div', { class: 'row', style: 'margin-bottom:10px' },
          h('input', { class: 'in', value: t.name, placeholder: 'Tier name', maxlength: '40', oninput: (e) => (t.name = e.target.value) }),
          h('input', { class: 'in', type: 'number', value: String(t.threshold), min: '1', placeholder: 'Points', oninput: (e) => (t.threshold = parseInt(e.target.value, 10) || 0) }),
          h('input', { class: 'in', value: t.tag, placeholder: 'Tag to add', maxlength: '60', oninput: (e) => (t.tag = e.target.value) }),
          h('button', { class: 'icon-btn fixed', 'aria-label': 'Remove tier', onclick: () => { tiers.splice(i, 1); drawTiers(); } }, '🗑')));
      });
    }
    drawTiers();

    p.append(
      h('div', { class: 'box' }, h('div', { class: 'box-h' }, h('h3', { text: 'VIP tiers' }),
        h('div', { class: 'row', style: 'flex:none' },
          h('button', { class: 'btn ghost sm', onclick: () => { tiers.push({ name: '', threshold: 1000, tag: '' }); drawTiers(); } }, '+ Add tier'),
          h('button', { class: 'btn sm', onclick: async (e) => { e.target.disabled = true; try { await api('/tiers', { method: 'PUT', body: { tiers } }); toast('Tiers saved'); } catch (er) { toast(er.message, true); } e.target.disabled = false; } }, 'Save tiers'))),
        h('div', { class: 'box-b' }, h('p', { class: 'small muted', style: 'margin-top:0', text: 'When a contact\'s balance first reaches a threshold, LoyaltyLoop adds the tag so your workflows can react. The tag is added once per contact.' }), tierBox)),

      h('div', { class: 'box' }, h('div', { class: 'box-h' }, h('h3', { text: 'Workflow webhook (manual awards from automations)' })),
        h('div', { class: 'box-b' }, h('p', { class: 'small muted', style: 'margin-top:0', text: 'In any workflow add a "Custom Webhook" action: method POST, this URL, header x-api-key = your key.' }),
          h('label', { class: 'f', text: 'URL' }), copyRow(ov.workflow.url),
          h('label', { class: 'f', text: 'API key' }), secretRow(ov.workflow.key),
          h('label', { class: 'f', text: 'Body' }),
          h('pre', {}, h('code', { text: '{\n  "contactId": "{{contact.id}}",\n  "action": "earn",   // or "burn"\n  "points": 50,\n  "reason": "Event attendance",\n  "idempotencyKey": "{{contact.id}}-event-2026-10"   // optional\n}' })))),

      h('div', { class: 'box' }, h('div', { class: 'box-h' }, h('h3', { text: 'Connection' })),
        h('div', { class: 'box-b kv' },
          h('strong', { text: 'Location ID' }), h('code', { text: ov.locationId }),
          h('strong', { text: 'Points field' }), h('span', {}, ov.field.id ? h('code', { text: ov.field.key }) : h('span', { class: 'fail', text: 'not created' })),
          h('strong', { text: 'Docs' }), h('a', { href: '/docs', target: '_blank', rel: 'noopener', text: 'Setup guide' })))
    );
  }

  function copyRow(value) {
    return h('div', { class: 'copy' }, h('code', { text: value }), h('button', { class: 'btn ghost sm', onclick: () => navigator.clipboard.writeText(value).then(() => toast('Copied'), () => toast('Copy failed', true)) }, 'Copy'));
  }

  function secretRow(key) {
    const codeEl = h('code', { text: '•'.repeat(24) });
    let shown = false;
    let current = key;
    return h('div', { class: 'copy' }, codeEl,
      h('button', { class: 'btn ghost sm', onclick: (e) => { shown = !shown; codeEl.textContent = shown ? current : '•'.repeat(24); e.target.textContent = shown ? 'Hide' : 'Show'; } }, 'Show'),
      h('button', { class: 'btn ghost sm', onclick: () => navigator.clipboard.writeText(current).then(() => toast('Copied'), () => toast('Copy failed', true)) }, 'Copy'),
      h('button', { class: 'btn danger sm', onclick: async () => {
        if (!confirm('Rotate the key? Workflows using the old key will stop working until you update them.')) return;
        try { current = (await api('/webhook-key/rotate', { method: 'POST' })).key; if (shown) codeEl.textContent = current; toast('New key generated'); } catch (e) { toast(e.message, true); }
      } }, 'Rotate'));
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    clear(root).append(h('div', { class: 'gate' }, h('span', { class: 'spin' }), h('p', { text: 'Connecting to your CRM…' })));
    try {
      await startSession();
      shell();
    } catch (e) {
      if (e.message === 'not_embedded') return gate('Open LoyaltyLoop from your CRM', 'This dashboard runs inside your CRM. Open your CRM account and click LoyaltyLoop in the left menu. To install the app, visit the install page.', false);
      if (e.message === 'timeout') return gate('Could not reach your CRM', 'The CRM did not send your session in time. Reload the page, or reopen LoyaltyLoop from the left menu.', true);
      gate(e.code === 'no_location' ? 'Choose an account location' : 'Sign-in problem', e.message, e.code !== 'not_installed' && e.code !== 'no_location');
    }
  }

  boot();
})();
