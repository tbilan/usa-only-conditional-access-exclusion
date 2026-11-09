const $ = (s) => document.querySelector(s);
const main = $('#main');
let tenants = [];
let current = null; // tenantId

// Build DOM safely (textContent only — tenant data is never parsed as HTML).
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === false || kid == null) continue; // skip `cond && node` results
    el.append(kid instanceof Node ? kid : document.createTextNode(kid));
  }
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '');
const sideMsg = (text, cls = '') => { const m = $('#sideMsg'); m.textContent = text; m.className = 'msg ' + cls; };

// ---- Sidebar ---------------------------------------------------------------

async function loadTenants() {
  const data = await api('GET', '/api/tenants');
  tenants = data.tenants;
  $('#importGdap').hidden = !data.canImport;
  if (!data.configured) sideMsg('Set real AZURE_CLIENT_ID / AZURE_CLIENT_SECRET values in .env (not the placeholders) and restart.', 'err');
  const ul = $('#tenantList');
  ul.replaceChildren(
    ...tenants.map((t) =>
      h('li', { class: 'tenant' + (t.tenantId === current ? ' active' : ''), onclick: () => openTenant(t.tenantId) },
        h('span', {}, t.name),
        t.exclusionCount ? h('span', { class: 'badge' }, String(t.exclusionCount)) : ''))
  );
  if (!tenants.length) ul.append(h('li', { class: 'muted' }, 'No tenants yet.'));
}

$('#addTenant').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('POST', '/api/tenants', { name: f.get('name'), tenantId: f.get('tenantId').trim() });
    e.target.reset();
    sideMsg('Tenant added.', 'good');
    await loadTenants();
  } catch (err) { sideMsg(err.message, 'err'); }
});

$('#importGdap').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/tenants/import-gdap');
    sideMsg(`Found ${r.found} customers, added ${r.added}.`, 'good');
    await loadTenants();
  } catch (err) { sideMsg(err.message, 'err'); }
});

$('#sweepNow').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/sweep');
    sideMsg(`Sweep done: ${r.removed} removed, ${r.failed} failed.`, r.failed ? 'err' : 'good');
    await loadTenants();
    if (current) openTenant(current);
  } catch (err) { sideMsg(err.message, 'err'); }
});

// ---- Tenant view -----------------------------------------------------------

const STATE_LABEL = {
  enabled: ['ON — blocking non-US sign-ins', 'ok'],
  enabledForReportingButNotEnforced: ['Report-only (not blocking)', 'warn'],
  disabled: ['OFF', 'bad'],
};

// Remove a tenant from this app (does not change anything in Entra).
function removeTenantCard(t) {
  const msg = h('span', { class: 'msg' });
  const del = async (force) => {
    try {
      await api('DELETE', `/api/tenants/${t.tenantId}`, { force });
      current = null;
      main.replaceChildren(h('p', { class: 'muted' }, `Removed ${t.name}.`));
      loadTenants();
    } catch (err) {
      if (!force && /tracked exclusion/.test(err.message) &&
          confirm(`${err.message}.\n\nRemoving the tenant forgets these exclusions, so any that have a removal date will NOT be removed automatically — those users stay excluded in Entra until you remove them there.\n\nRemove ${t.name} anyway?`)) {
        return del(true);
      }
      msg.textContent = err.message; msg.className = 'msg err';
    }
  };
  return h('div', { class: 'card' },
    h('div', { class: 'row' },
      h('button', { class: 'danger', onclick: () => {
        if (confirm(`Remove ${t.name} from this app?\n\nThis only removes it from the app. The policy, group and members in the tenant are NOT changed.`)) del(false);
      } }, 'Remove tenant from app'), msg));
}

async function openTenant(tenantId) {
  current = tenantId;
  loadTenants();
  main.replaceChildren(h('p', { class: 'muted' }, 'Loading from Microsoft Graph…'));
  try {
    const status = await api('GET', `/api/tenants/${tenantId}/status`);
    render(status);
  } catch (err) {
    const t = tenants.find((x) => x.tenantId === tenantId);
    main.replaceChildren(
      h('h2', {}, t ? t.name : tenantId),
      h('p', { class: 'err' }, err.message),
      t ? h('p', {}, 'If this tenant has not approved the app yet, send an admin this link: ',
        h('a', { href: t.consentUrl, target: '_blank', rel: 'noopener' }, 'Grant admin consent')) : '',
      t ? removeTenantCard(t) : ''
    );
  }
}

function render(s) {
  const t = s.tenant;
  const msg = h('p', { class: 'msg' });
  const say = (text, cls) => { msg.textContent = text; msg.className = 'msg ' + (cls || ''); };
  const act = (fn, okText) => async () => {
    say('Working…');
    try { await fn(); await openTenant(t.tenantId); } catch (err) { say(err.message, 'err'); return; }
    if (okText) say(okText, 'good');
  };
  const base = `/api/tenants/${t.tenantId}`;

  if (s.needsPolicy) return renderChooser(t, act, msg);

  const state = s.policy && STATE_LABEL[s.policy.state];
  const st = s.policy && s.policy.state;
  const policyCard = h('div', { class: 'card' },
    h('h2', {}, t.name),
    h('div', { class: 'row' },
      h('span', {}, 'Policy: '),
      h('strong', {}, s.policy ? s.policy.displayName : (t.policyName || '(missing)')),
      state ? h('span', { class: 'badge ' + state[1] }, state[0]) : h('span', { class: 'badge bad' }, 'Not found'),
      s.policy && st !== 'enabledForReportingButNotEnforced' &&
        h('button', { class: 'secondary', onclick: act(() => api('PATCH', `${base}/policy`, { state: 'reportOnly' })) }, 'Set report-only'),
      s.policy && st !== 'enabled' &&
        h('button', { class: 'danger', onclick: () => {
          if (confirm(`Turn ON "${s.policy.displayName}" for ${t.name}?\n\nUsers who are not excluded and fail the policy's conditions will be blocked. Make sure your break-glass accounts are excluded.`))
            act(() => api('PATCH', `${base}/policy`, { state: 'on' }))();
        } }, 'Turn ON'),
      s.policy && st !== 'disabled' &&
        h('button', { class: 'secondary', onclick: act(() => api('PATCH', `${base}/policy`, { state: 'off' })) }, 'Turn OFF'),
      h('button', { class: 'secondary', onclick: () => { if (confirm('Stop managing this policy and choose a different one?\n\nThe exclusions group stays on the old policy.')) act(() => api('DELETE', `${base}/policy/select`))(); } }, 'Change policy')),
    h('p', { class: 'muted' }, `Exclusions group: ${s.group ? s.group.displayName : '—'}`),
    s.drift.map((d) => h('p', { class: 'err' }, '⚠ ' + d)),
    s.drift.length && s.policy
      ? h('button', { onclick: act(() => api('POST', `${base}/policy/select`, { policyId: s.policy.id }), 'Repaired.') }, 'Repair')
      : '',
    msg
  );

  main.replaceChildren(policyCard);
  if (s.ready) {
    main.append(addForm(t, s, act, say), exclusionTable(t, s, act, say));
    if (s.untracked.length) main.append(untrackedTable(t, s, act, say));
    main.append(auditCard(s));
  }
  main.append(removeTenantCard(t));
}

// First visit (or after "Change policy"): discover the tenant's CA policies and let the user pick one.
async function renderChooser(t, act, msg) {
  const base = `/api/tenants/${t.tenantId}`;
  const card = h('div', { class: 'card' }, h('h2', {}, t.name),
    h('p', {}, 'Which existing Conditional Access policy enforces US-only sign-ins in this tenant?'),
    h('p', { class: 'muted' }, 'Choosing one adds the "USA-only CA Exclusions" group to that policy\'s excluded groups (creating the group if needed). Nothing else on the policy is changed.'),
    h('p', { class: 'muted' }, 'Discovering policies…'));
  main.replaceChildren(card);

  let policies;
  try { policies = await api('GET', `${base}/policies`); } catch (err) {
    card.querySelector('p.muted:last-child').remove();
    const full = tenants.find((x) => x.tenantId === t.tenantId);
    card.append(h('p', { class: 'err' }, err.message),
      full ? h('p', {}, 'If this tenant has not approved the app yet, send an admin this link: ',
        h('a', { href: full.consentUrl, target: '_blank', rel: 'noopener' }, 'Grant admin consent')) : '');
    main.append(removeTenantCard(t));
    return;
  }
  card.querySelector('p.muted:last-child').remove();

  const list = (arr) => (arr.length ? arr.join(', ') : '—');
  const rows = policies.map((p) => {
    const st = STATE_LABEL[p.state] || [p.state, ''];
    return h('tr', {},
      h('td', {}, h('strong', {}, p.displayName), h('br'),
        p.rank === 2 ? h('span', { class: 'badge ok' }, 'Likely US-only') : p.rank === 1 ? h('span', { class: 'badge warn' }, 'Blocks by location') : ''),
      h('td', {}, h('span', { class: 'badge ' + st[1] }, st[0].split(' — ')[0])),
      h('td', {}, p.blocks ? 'Block' : 'Other controls', h('br'), h('span', { class: 'muted' }, p.appliesTo)),
      h('td', {}, 'Include: ' + list(p.includeLocations), h('br'), 'Exclude: ' + list(p.excludeLocations)),
      h('td', {}, h('button', { onclick: () => {
        if (confirm(`Use "${p.displayName}" as the US-only policy for ${t.name}?`))
          act(() => api('POST', `${base}/policy/select`, { policyId: p.id }))();
      } }, 'Use this policy')));
  });
  card.append(
    policies.length
      ? h('table', {}, h('thead', {}, h('tr', {}, ['Policy', 'State', 'Action', 'Locations', ''].map((c) => h('th', {}, c)))), h('tbody', {}, rows))
      : h('p', { class: 'muted' }, 'No Conditional Access policies found in this tenant.'),
    h('p', {}, h('button', { class: 'secondary', onclick: () => {
      if (confirm(`Create a NEW "USA-only Conditional Access" policy in ${t.name} (report-only)?`))
        act(() => api('POST', `${base}/policy/create`, { mode: 'reportOnly' }))();
    } }, 'None of these — create a new US-only policy (report-only)')),
    msg);
  main.append(removeTenantCard(t));
}

function addForm(t, s, act, say) {
  const card = h('div', { class: 'card' }, h('h2', {}, 'Add exclusion'));
  const filter = h('input', { placeholder: 'Filter users…', 'aria-label': 'Filter users' });
  const pick = h('select', { size: '8', 'aria-label': 'Users' }, h('option', { disabled: true }, 'Loading users…'));
  const perm = h('input', { type: 'checkbox' });
  const date = h('input', { type: 'date', required: true });
  const reason = h('input', { placeholder: 'Reason (e.g. traveling to Mexico)', size: '40' });
  const btn = h('button', { disabled: true }, 'Add exclusion');
  let users = [];
  const excluded = new Set(s.exclusions.map((x) => x.userId.toLowerCase()).concat(s.untracked.map((x) => x.id.toLowerCase())));

  const fill = () => {
    const q = filter.value.toLowerCase();
    const shown = users.filter((u) => !excluded.has(u.id.toLowerCase()) && (u.displayName + ' ' + u.upn).toLowerCase().includes(q));
    pick.replaceChildren(...shown.map((u) => h('option', { value: u.id }, `${u.displayName} — ${u.upn}${u.enabled === false ? ' (disabled)' : ''}${u.userType === 'Guest' ? ' (guest)' : ''}`)));
    if (!shown.length) pick.append(h('option', { disabled: true }, 'No matching users'));
  };
  const sync = () => { date.disabled = perm.checked; date.required = !perm.checked; btn.disabled = !pick.value || (!perm.checked && !date.value); };
  filter.addEventListener('input', fill);
  [pick, perm, date].forEach((el) => el.addEventListener('change', sync));
  const tomorrow = new Date(Date.now() + 864e5);
  date.min = new Date().toLocaleDateString('en-CA');
  date.value = tomorrow.toLocaleDateString('en-CA');

  btn.addEventListener('click', act(async () => {
    await api('POST', `/api/tenants/${t.tenantId}/exclusions`, {
      userId: pick.value, permanent: perm.checked, expiresOn: perm.checked ? null : date.value, reason: reason.value,
    });
  }, 'Exclusion added.'));
  void say;

  api('GET', `/api/tenants/${t.tenantId}/users`).then((u) => { users = u; fill(); sync(); })
    .catch((e) => pick.replaceChildren(h('option', { disabled: true }, e.message)));

  card.append(filter, pick,
    h('div', { class: 'row' },
      h('label', { class: 'inline' }, perm, 'Permanent'),
      h('label', { class: 'inline' }, 'Removed after ', date),
    ),
    h('label', {}, reason),
    h('p', { class: 'muted' }, 'A dated exclusion stays active through the end of that day (this computer\'s time) and is removed automatically by the next sweep while this app is running.'),
    btn);
  return card;
}

function editTerms(t, x, act) {
  return () => {
    const input = prompt(`New removal date for ${x.upn} (YYYY-MM-DD), or type "permanent":`, x.expiresOn || 'permanent');
    if (input === null) return;
    const permanent = input.trim().toLowerCase() === 'permanent';
    act(() => api('PATCH', `/api/tenants/${t.tenantId}/exclusions/${x.userId}`, { permanent, expiresOn: permanent ? null : input.trim() }))();
  };
}

function exclusionTable(t, s, act) {
  const rows = s.exclusions.map((x) => h('tr', {},
    h('td', {}, x.displayName, h('br'), h('span', { class: 'muted' }, x.upn)),
    h('td', {}, x.permanent ? h('span', { class: 'badge warn' }, 'Permanent') : `Removed after ${x.expiresOn}`),
    h('td', {}, x.reason || '', !x.inGroup && h('div', { class: 'err' }, 'Not in group — drift'), x.lastError && h('div', { class: 'err' }, 'Last error: ' + x.lastError)),
    h('td', {}, fmtDate(x.addedAt)),
    h('td', { class: 'row' },
      h('button', { class: 'secondary', onclick: editTerms(t, x, act) }, 'Edit'),
      h('button', { class: 'secondary', onclick: () => { if (confirm(`Remove exclusion for ${x.upn}?`)) act(() => api('DELETE', `/api/tenants/${t.tenantId}/exclusions/${x.userId}`))(); } }, 'Remove'))));
  return h('div', { class: 'card' }, h('h2', {}, `Exclusions (${s.exclusions.length})`),
    s.exclusions.length
      ? h('table', {}, h('thead', {}, h('tr', {}, ['User', 'Term', 'Reason', 'Added', ''].map((c) => h('th', {}, c)))), h('tbody', {}, rows))
      : h('p', { class: 'muted' }, 'Nobody is excluded — everyone is held to US-only.'));
}

function untrackedTable(t, s, act) {
  return h('div', { class: 'card' }, h('h2', {}, `In the group but not tracked (${s.untracked.length})`),
    h('p', { class: 'muted' }, 'These members were added outside this app, so they have no removal date. Give them one, or remove them.'),
    h('table', {}, h('tbody', {}, s.untracked.map((m) => h('tr', {},
      h('td', {}, m.displayName || m.id, h('br'), h('span', { class: 'muted' }, m.userPrincipalName || '')),
      h('td', { class: 'row' },
        h('button', { class: 'secondary', onclick: () => {
          const d = prompt('Removal date (YYYY-MM-DD), or "permanent":', 'permanent');
          if (d === null) return;
          const permanent = d.trim().toLowerCase() === 'permanent';
          act(() => api('POST', `/api/tenants/${t.tenantId}/exclusions`, { userId: m.id, permanent, expiresOn: permanent ? null : d.trim(), reason: 'Adopted from group' }))();
        } }, 'Track…'),
        h('button', { class: 'secondary', onclick: () => { if (confirm(`Remove ${m.userPrincipalName || m.id} from the group?`)) act(() => api('DELETE', `/api/tenants/${t.tenantId}/exclusions/${m.id}`))(); } }, 'Remove')))))));
}

function auditCard(s) {
  return h('div', { class: 'card' }, h('h2', {}, 'Recent activity'),
    s.audit.length
      ? h('table', {}, h('tbody', {}, s.audit.map((a) => h('tr', {}, h('td', { class: 'muted' }, fmtDate(a.at)), h('td', {}, a.action), h('td', {}, a.detail)))))
      : h('p', { class: 'muted' }, 'Nothing yet.'));
}

loadTenants();
