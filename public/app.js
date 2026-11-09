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
  for (const kid of kids.flat()) el.append(kid instanceof Node ? kid : document.createTextNode(kid ?? ''));
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
  if (!data.configured) sideMsg('Set AZURE_CLIENT_ID / AZURE_CLIENT_SECRET in .env and restart.', 'err');
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
        h('a', { href: t.consentUrl, target: '_blank', rel: 'noopener' }, 'Grant admin consent')) : ''
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

  const state = s.policy && STATE_LABEL[s.policy.state];
  const policyCard = h('div', { class: 'card' },
    h('h2', {}, t.name),
    h('div', { class: 'row' },
      h('span', {}, 'Policy: '),
      state ? h('span', { class: 'badge ' + state[1] }, state[0]) : h('span', { class: 'badge bad' }, 'Not provisioned'),
      !s.provisioned && h('button', { onclick: act(() => api('POST', `/api/tenants/${t.tenantId}/provision`, { mode: 'reportOnly' }), 'Provisioned in report-only mode.') }, 'Provision (report-only)'),
      s.provisioned && s.policy.state !== 'reportOnly' && s.policy.state !== 'enabledForReportingButNotEnforced' &&
        h('button', { class: 'secondary', onclick: act(() => api('PATCH', `/api/tenants/${t.tenantId}/policy`, { state: 'reportOnly' })) }, 'Set report-only'),
      s.provisioned && s.policy.state !== 'enabled' &&
        h('button', { class: 'danger', onclick: () => {
          if (confirm(`Turn ON the US-only block for ${t.name}?\n\nUsers outside the US who are not excluded will be blocked. Check the Entra sign-in report (report-only results) first, and make sure your break-glass accounts are excluded.`))
            act(() => api('PATCH', `/api/tenants/${t.tenantId}/policy`, { state: 'on' }))();
        } }, 'Turn ON'),
      s.provisioned && s.policy.state !== 'disabled' &&
        h('button', { class: 'secondary', onclick: act(() => api('PATCH', `/api/tenants/${t.tenantId}/policy`, { state: 'off' })) }, 'Turn OFF')),
    h('p', { class: 'muted' }, `Exclusions group: ${s.group ? s.group.displayName : '—'} · Allowed location: ${s.location ? s.location.displayName : '—'}`),
    s.drift.map((d) => h('p', { class: 'err' }, '⚠ ' + d + '. Run Provision again to repair.')),
    s.drift.length ? h('button', { onclick: act(() => api('POST', `/api/tenants/${t.tenantId}/provision`, {}), 'Repaired.') }, 'Repair') : '',
    msg
  );

  main.replaceChildren(policyCard);
  if (!s.provisioned) return;
  main.append(addForm(t, s, act, say), exclusionTable(t, s, act, say));
  if (s.untracked.length) main.append(untrackedTable(t, s, act, say));
  main.append(auditCard(s));
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
