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
      policyChosen: !!t.policyId,
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

// Removes the tenant from THIS app only. Nothing is changed in Entra (the policy and its
// excluded users stay as they are). Tracked exclusions would stop expiring, so require force if any exist.
app.delete('/api/tenants/:tenantId', wrap(async (req, res) => {
  const n = store.exclusions(req.tenant.tenantId).length;
  if (n && req.body?.force !== true) {
    throw Object.assign(bad(`${n} tracked exclusion(s) exist for this tenant`, 409), { code: 'HAS_EXCLUSIONS' });
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
  if (!req.tenant.policyId) return res.json({ tenant: req.tenant, needsPolicy: true });
  const status = await ca.getStatus(t, req.tenant.policyId);
  const tracked = store.exclusions(t);
  const excludedIds = new Set(status.excluded.map((m) => m.id.toLowerCase()));
  res.json({
    tenant: req.tenant,
    ...status,
    exclusions: tracked.map((x) => ({ ...x, inPolicy: excludedIds.has(x.userId.toLowerCase()) })),
    untracked: status.excluded.filter((m) => !store.findExclusion(t, m.id)),
    audit: store.auditLog(t),
  });
}));

// Discover the tenant's existing Conditional Access policies so one can be chosen.
app.get('/api/tenants/:tenantId/policies', wrap(async (req, res) => {
  res.json(await ca.listPolicies(req.tenant.tenantId));
}));

// Choose which existing policy is "the US-only policy" for this tenant. Nothing is modified in
// the tenant: excluded users are added directly to this policy's Exclude -> Users list later.
app.post('/api/tenants/:tenantId/policy/select', wrap(async (req, res) => {
  const policyId = req.body?.policyId;
  if (!GUID.test(policyId || '')) throw bad('policyId must be a GUID');
  const policy = await ca.getPolicy(req.tenant.tenantId, policyId);
  if (!policy) throw bad('Policy not found in this tenant', 404);
  store.setTenantPolicy(req.tenant.tenantId, policy.id, policy.displayName);
  store.audit(req.tenant.tenantId, 'policy-selected', `Using policy "${policy.displayName}"`);
  res.json({ policyId: policy.id });
}));

// Create a new US-only policy (for tenants that don't already have one).
app.post('/api/tenants/:tenantId/policy/create', wrap(async (req, res) => {
  const mode = req.body?.mode === 'on' ? 'on' : 'reportOnly';
  const r = await ca.createPolicy(req.tenant.tenantId, mode);
  store.setTenantPolicy(req.tenant.tenantId, r.policyId, r.policyName);
  store.audit(req.tenant.tenantId, 'policy-created', `Created "${r.policyName}" (${mode})`);
  res.json(r);
}));

// Forget the chosen policy so another can be picked (users already excluded stay excluded on the old policy).
app.delete('/api/tenants/:tenantId/policy/select', wrap(async (req, res) => {
  store.setTenantPolicy(req.tenant.tenantId, undefined, undefined);
  store.audit(req.tenant.tenantId, 'policy-unlinked', `Stopped managing "${req.tenant.policyName}"`);
  res.json({ ok: true });
}));

app.patch('/api/tenants/:tenantId/policy', wrap(async (req, res) => {
  const state = req.body?.state;
  if (!['reportOnly', 'on', 'off'].includes(state)) throw bad('state must be reportOnly, on or off');
  if (!req.tenant.policyId) throw bad('Choose a policy first', 409);
  await ca.setPolicyState(req.tenant.tenantId, req.tenant.policyId, state);
  store.audit(req.tenant.tenantId, 'policy-state', `"${req.tenant.policyName}" set to ${state}`);
  res.json({ ok: true });
}));

// ---- Recent sign-in countries for the users excluded in the chosen policy ----
// Needs the AuditLog.Read.All application permission and Entra ID P1/P2 in the tenant.
const signInCache = new Map(); // tenantId -> { at, data }

app.get('/api/tenants/:tenantId/signins', wrap(async (req, res) => {
  const t = req.tenant.tenantId;
  if (!req.tenant.policyId) throw bad('Choose a policy first', 409);
  const hit = signInCache.get(t);
  if (hit && Date.now() - hit.at < 5 * 60_000 && req.query.refresh !== '1') return res.json(hit.data);

  const policy = await ca.getPolicy(t, req.tenant.policyId);
  const ids = ((policy && policy.conditions?.users?.excludeUsers) || []).filter((u) => GUID.test(u)).slice(0, 100);
  const data = {};
  try {
    for (let i = 0; i < ids.length; i += 5) {
      await Promise.all(ids.slice(i, i + 5).map(async (id) => { data[id.toLowerCase()] = await ca.recentSignIns(t, id, 5); }));
    }
  } catch (e) {
    if (e.status === 403) {
      throw bad('Sign-in logs need the AuditLog.Read.All application permission on the app (granted in this tenant) and Entra ID P1/P2 licensing.', 403);
    }
    throw e;
  }
  signInCache.set(t, { at: Date.now(), data });
  res.json(data);
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

  if (!req.tenant.policyId) throw bad('Choose a policy for this tenant first', 409);
  const user = await ca.getUser(t, userId);
  await ca.addExcludedUser(t, req.tenant.policyId, userId);

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
  if (req.tenant.policyId) await ca.removeExcludedUser(t, req.tenant.policyId, req.params.userId);
  if (ex) store.deleteExclusion(t, req.params.userId);
  store.audit(t, 'exclusion-removed', ex ? ex.upn : req.params.userId);
  res.json({ ok: true });
}));

// ---- Expiry sweeps ---------------------------------------------------------

async function runSweep() {
  const r = await sweep({ store, removeMember: async (tid, uid) => {
      const policyId = store.getTenant(tid)?.policyId;
      if (!policyId) throw new Error('No policy selected for this tenant');
      await ca.removeExcludedUser(tid, policyId, uid);
    } });
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
