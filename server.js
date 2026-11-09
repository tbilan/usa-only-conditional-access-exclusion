const express = require('express');
const path = require('path');
const cfg = require('./lib/config');
const { GUID, graphAll } = require('./lib/graph');
const { createStore } = require('./lib/store');
const ca = require('./lib/ca');
const { localDate, isExpired, sweep } = require('./lib/expiry');

const store = createStore(path.join(cfg.dataDir, 'db.json'));
const app = express();
app.disable('x-powered-by');

// This app can change security policy, so it is local-only and hardened against
// DNS-rebinding (Host check) and cross-site requests (JSON-only mutations).
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `localhost:${cfg.port}` && host !== `127.0.0.1:${cfg.port}`) {
    return res.status(403).send('Forbidden host');
  }
  if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'application/json required' });
  }
  res.set('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'");
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    res.status(status).json({ error: e.message, code: e.code });
  });

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

app.param('tenantId', (req, res, next, id) => {
  if (!GUID.test(id)) return res.status(400).json({ error: 'Invalid tenant ID' });
  const tenant = store.getTenant(id);
  if (!tenant) return res.status(404).json({ error: 'Unknown tenant' });
  req.tenant = tenant;
  next();
});

const consentUrl = (tenantId) =>
  `https://login.microsoftonline.com/${tenantId}/adminconsent?client_id=${encodeURIComponent(cfg.clientId)}` +
  `&redirect_uri=${encodeURIComponent(`http://localhost:${cfg.port}/consent-done.html`)}`;

// ---- Tenants ---------------------------------------------------------------

app.get('/api/tenants', (req, res) => {
  res.json({
    configured: !!(cfg.clientId && cfg.clientSecret),
    canImport: !!cfg.partnerTenantId,
    tenants: store.tenants().map((t) => ({
      ...t,
      exclusionCount: store.exclusions(t.tenantId).length,
      consentUrl: consentUrl(t.tenantId),
    })),
  });
});

app.post('/api/tenants', wrap(async (req, res) => {
  const { tenantId, name } = req.body || {};
  if (!GUID.test(tenantId || '')) throw bad('Tenant ID must be a GUID');
  if (!name || !String(name).trim()) throw bad('Name is required');
  if (!store.addTenant(tenantId, String(name).trim().slice(0, 100))) throw bad('Tenant already added', 409);
  res.status(201).json({ ok: true });
}));

app.delete('/api/tenants/:tenantId', wrap(async (req, res) => {
  if (store.exclusions(req.tenant.tenantId).length) {
    throw bad('Remove this tenant\'s exclusions first so nothing is left in its group untracked', 409);
  }
  store.removeTenant(req.tenant.tenantId);
  res.json({ ok: true });
}));

// Pull customer tenants from your GDAP relationships (needs PARTNER_TENANT_ID and
// DelegatedAdminRelationship.Read.All consented in the partner tenant).
app.post('/api/tenants/import-gdap', wrap(async (req, res) => {
  if (!cfg.partnerTenantId) throw bad('PARTNER_TENANT_ID is not set in .env');
  const customers = await graphAll(cfg.partnerTenantId, '/tenantRelationships/delegatedAdminCustomers');
  let added = 0;
  for (const c of customers) {
    if (GUID.test(c.tenantId || '') && store.addTenant(c.tenantId, c.displayName || c.tenantId)) added++;
  }
  res.json({ found: customers.length, added });
}));

// ---- Policy status / provisioning -----------------------------------------

app.get('/api/tenants/:tenantId/status', wrap(async (req, res) => {
  const t = req.tenant.tenantId;
  const status = await ca.getStatus(t);
  const tracked = store.exclusions(t);
  const memberIds = new Set(status.members.map((m) => m.id.toLowerCase()));
  res.json({
    tenant: req.tenant,
    ...status,
    exclusions: tracked.map((x) => ({ ...x, inGroup: memberIds.has(x.userId.toLowerCase()) })),
    untracked: status.members.filter((m) => !store.findExclusion(t, m.id)),
    audit: store.auditLog(t),
  });
}));

app.post('/api/tenants/:tenantId/provision', wrap(async (req, res) => {
  const mode = req.body?.mode === 'on' ? 'on' : 'reportOnly';
  const r = await ca.provision(req.tenant.tenantId, mode);
  store.audit(req.tenant.tenantId, 'provisioned', `Policy/group/location ensured (new policy mode: ${mode})`);
  res.json(r);
}));

app.patch('/api/tenants/:tenantId/policy', wrap(async (req, res) => {
  const state = req.body?.state;
  if (!['reportOnly', 'on', 'off'].includes(state)) throw bad('state must be reportOnly, on or off');
  await ca.setPolicyState(req.tenant.tenantId, state);
  store.audit(req.tenant.tenantId, 'policy-state', `Policy set to ${state}`);
  res.json({ ok: true });
}));

// ---- Users picklist --------------------------------------------------------

app.get('/api/tenants/:tenantId/users', wrap(async (req, res) => {
  res.json(await ca.listUsers(req.tenant.tenantId));
}));

// ---- Exclusions ------------------------------------------------------------

function parseTerms(body) {
  const permanent = body.permanent === true;
  if (permanent) return { permanent: true, expiresOn: null };
  const d = body.expiresOn;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '') || Number.isNaN(Date.parse(d))) {
    throw bad('Choose a removal date, or tick "Permanent"');
  }
  if (d < localDate()) throw bad('Removal date cannot be in the past');
  return { permanent: false, expiresOn: d };
}

app.post('/api/tenants/:tenantId/exclusions', wrap(async (req, res) => {
  const t = req.tenant.tenantId;
  const { userId, reason } = req.body || {};
  if (!GUID.test(userId || '')) throw bad('userId must be a GUID');
  const terms = parseTerms(req.body);

  const group = await ca.findGroup(t);
  if (!group) throw bad('Provision the policy for this tenant first', 409);
  const user = await ca.getUser(t, userId);
  await ca.addMember(t, group.id, userId);

  store.upsertExclusion({
    tenantId: t,
    userId: user.id,
    displayName: user.displayName,
    upn: user.userPrincipalName,
    ...terms,
    reason: String(reason || '').slice(0, 300),
    addedAt: store.findExclusion(t, userId)?.addedAt || new Date().toISOString(),
    lastError: null,
  });
  store.audit(t, 'exclusion-added', `${user.userPrincipalName} — ${terms.permanent ? 'permanent' : 'until ' + terms.expiresOn}`);
  res.status(201).json({ ok: true });
}));

app.patch('/api/tenants/:tenantId/exclusions/:userId', wrap(async (req, res) => {
  const t = req.tenant.tenantId;
  const ex = store.findExclusion(t, req.params.userId);
  if (!ex) throw bad('Exclusion not tracked', 404);
  const terms = parseTerms(req.body || {});
  const reason = req.body.reason !== undefined ? String(req.body.reason).slice(0, 300) : ex.reason;
  store.upsertExclusion({ tenantId: t, userId: ex.userId, ...terms, reason, lastError: null });
  store.audit(t, 'exclusion-updated', `${ex.upn} — ${terms.permanent ? 'permanent' : 'until ' + terms.expiresOn}`);
  res.json({ ok: true });
}));

app.delete('/api/tenants/:tenantId/exclusions/:userId', wrap(async (req, res) => {
  const t = req.tenant.tenantId;
  if (!GUID.test(req.params.userId)) throw bad('userId must be a GUID');
  const ex = store.findExclusion(t, req.params.userId);
  await ca.removeMemberByTenant(t, req.params.userId);
  if (ex) store.deleteExclusion(t, req.params.userId);
  store.audit(t, 'exclusion-removed', ex ? ex.upn : req.params.userId);
  res.json({ ok: true });
}));

// ---- Expiry sweeps ---------------------------------------------------------

async function runSweep() {
  const r = await sweep({ store, removeMember: ca.removeMemberByTenant });
  if (r.removed.length || r.failed.length) {
    console.log(`[sweep] removed ${r.removed.length}, failed ${r.failed.length}`);
    r.failed.forEach((f) => console.error(`[sweep] ${f.upn} (${f.tenantId}): ${f.error}`));
  }
  return r;
}

app.post('/api/sweep', wrap(async (req, res) => {
  const r = await runSweep();
  res.json({ removed: r.removed.length, failed: r.failed.length });
}));

app.listen(cfg.port, '127.0.0.1', () => {
  console.log(`USA-only Conditional Access Exclusion → http://localhost:${cfg.port}`);
  if (!cfg.clientId || !cfg.clientSecret) console.warn('AZURE_CLIENT_ID / AZURE_CLIENT_SECRET missing — copy .env.example to .env');
  runSweep().catch((e) => console.error('[sweep]', e.message));
  setInterval(() => runSweep().catch((e) => console.error('[sweep]', e.message)), cfg.sweepIntervalMinutes * 60_000);
});

module.exports = { isExpired };
