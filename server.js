const express = require('express');
const path = require('path');
const cfg = require('./lib/config');
const { GUID, graphAll } = require('./lib/graph');
const { createStore } = require('./lib/store');
const ca = require('./lib/ca');
const { localDate, isValidDate, isExpired, sweep } = require('./lib/expiry');
const auth = require('./lib/auth');

const store = createStore(path.join(cfg.dataDir, 'db.json'));
const app = express();
app.disable('x-powered-by');
if (cfg.trustProxy) app.set('trust proxy', 1);

if (cfg.authDisabled && !['127.0.0.1', 'localhost'].includes(cfg.host)) {
  console.error('AUTH_DISABLED=true is only allowed with HOST=127.0.0.1. Refusing to start.');
  process.exit(1);
}

// This app can change security policy, so it checks the Host header (DNS rebinding), accepts only
// JSON for changes (cross-site forms), and requires a bilan.com sign-in (lib/auth.js).
app.get('/healthz', (req, res) => res.send('ok')); // App Service health probe: no data, exempt from the host check
const allowedHosts = new Set([...(process.env.WEBSITE_HOSTNAME ? [process.env.WEBSITE_HOSTNAME.toLowerCase()] : []), `localhost:${cfg.port}`, `127.0.0.1:${cfg.port}`, new URL(cfg.baseUrl).host.toLowerCase()]);
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  if (!allowedHosts.has(host)) {
    return res.status(403).send('Forbidden host');
  }
  if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'application/json required' });
  }
  res.set('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'");
  next();
});
app.use(express.json());
auth.install(app); // /auth/* routes, then everything after this requires sign-in
app.use(express.static(path.join(__dirname, 'public')));

// Audit entries record who did it.
const audit = (req, tenantId, action, detail) => store.audit(tenantId, action, detail, req.user && req.user.upn);

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
  `&redirect_uri=${encodeURIComponent(`${cfg.baseUrl}/consent-done.html`)}`;

// ---- Tenants ---------------------------------------------------------------

app.get('/api/tenants', (req, res) => {
  res.json({
    configured: !!(cfg.clientId && cfg.clientSecret),
    canImport: !!cfg.partnerTenantId,
    today: localDate(),
    timezone: cfg.timezone,
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

// Resolve a user ID to "Name (upn)" for log text (cached; falls back gracefully).
const nameCache = new Map();
async function nameOf(tenantId, userId) {
  const key = `${tenantId}:${userId.toLowerCase()}`;
  if (nameCache.has(key)) return nameCache.get(key);
  let name;
  try {
    const u = await ca.getUser(tenantId, userId);
    name = `${u.displayName} (${u.userPrincipalName})`;
  } catch (e) {
    if (e.status !== 404) return '(name unavailable right now)'; // transient: don't cache
    name = '(a user that no longer exists)';
  }
  nameCache.set(key, name);
  return name;
}

// Older log entries may contain raw IDs; swap them for names when the log is shown.
const GUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
async function readableAudit(tenantId, entries) {
  return Promise.all(entries.map(async (a) => {
    let detail = a.detail || '';
    for (const id of new Set(detail.match(GUID_G) || [])) detail = detail.split(id).join(await nameOf(tenantId, id));
    return { ...a, detail };
  }));
}

app.get('/api/tenants/:tenantId/status', wrap(async (req, res) => {
  const t = req.tenant.tenantId;
  if (!req.tenant.policyId) return res.json({ tenant: req.tenant, needsPolicy: true });
  const status = await ca.getStatus(t, req.tenant.policyId);
  const tracked = store.exclusions(t);
  const excludedIds = new Set(status.excluded.map((m) => m.id.toLowerCase()));
  res.json({
    tenant: req.tenant,
    ...status,
    exclusions: tracked.map((x) => {
      const otherPolicy = !!x.policyId && x.policyId.toLowerCase() !== req.tenant.policyId.toLowerCase();
      return { ...x, otherPolicy, inPolicy: !otherPolicy && excludedIds.has(x.userId.toLowerCase()) };
    }),
    untracked: status.excluded.filter((m) => !store.findExclusion(t, m.id)),
    audit: await readableAudit(t, store.auditLog(t)),
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
  audit(req, req.tenant.tenantId, 'policy-selected', `Using policy "${policy.displayName}"`);
  res.json({ policyId: policy.id });
}));

// Create a new US-only policy (for tenants that don't already have one).
app.post('/api/tenants/:tenantId/policy/create', wrap(async (req, res) => {
  const mode = req.body?.mode === 'on' ? 'on' : 'reportOnly';
  const r = await ca.createPolicy(req.tenant.tenantId, mode);
  store.setTenantPolicy(req.tenant.tenantId, r.policyId, r.policyName);
  audit(req, req.tenant.tenantId, 'policy-created', `Created "${r.policyName}" (${mode})`);
  res.json(r);
}));

// Forget the chosen policy so another can be picked (users already excluded stay excluded on the old policy).
app.delete('/api/tenants/:tenantId/policy/select', wrap(async (req, res) => {
  store.setTenantPolicy(req.tenant.tenantId, undefined, undefined);
  audit(req, req.tenant.tenantId, 'policy-unlinked', `Stopped managing "${req.tenant.policyName}"`);
  res.json({ ok: true });
}));

app.patch('/api/tenants/:tenantId/policy', wrap(async (req, res) => {
  const state = req.body?.state;
  if (!['reportOnly', 'on', 'off'].includes(state)) throw bad('state must be reportOnly, on or off');
  if (!req.tenant.policyId) throw bad('Choose a policy first', 409);
  await ca.setPolicyState(req.tenant.tenantId, req.tenant.policyId, state);
  audit(req, req.tenant.tenantId, 'policy-state', `"${req.tenant.policyName}" set to ${state}`);
  res.json({ ok: true });
}));

// ---- Recent sign-in countries (one user per request so the UI can show progress) ----
// Needs the AuditLog.Read.All application permission and Entra ID P1/P2 in the tenant.
const signInCache = new Map(); // `${tenantId}:${userId}` -> { at, data }

app.get('/api/tenants/:tenantId/signins/:userId', wrap(async (req, res) => {
  const t = req.tenant.tenantId;
  const id = req.params.userId;
  if (!GUID.test(id)) throw bad('userId must be a GUID');
  const key = `${t}:${id.toLowerCase()}`;
  const hit = signInCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return res.json(hit.data);
  try {
    const data = await ca.recentSignIns(t, id, 5);
    signInCache.set(key, { at: Date.now(), data });
    res.json(data);
  } catch (e) {
    if (e.status === 403) {
      throw bad('Sign-in logs need the AuditLog.Read.All application permission on the app (granted in this tenant) and Entra ID P1/P2 licensing.', 403);
    }
    throw e;
  }
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
  if (!isValidDate(d)) {
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
  const existing = store.findExclusion(t, userId);
  if (existing && existing.policyId && existing.policyId.toLowerCase() !== req.tenant.policyId.toLowerCase()) {
    throw bad('This user is still tracked on a previously selected policy. Remove that exclusion first.', 409);
  }
  const user = await ca.getUser(t, userId);
  await ca.addExcludedUser(t, req.tenant.policyId, userId);

  store.upsertExclusion({
    tenantId: t,
    userId: user.id,
    displayName: user.displayName,
    upn: user.userPrincipalName,
    ...terms,
    policyId: req.tenant.policyId,
    reason: String(reason || '').slice(0, 300),
    addedAt: store.findExclusion(t, userId)?.addedAt || new Date().toISOString(),
    lastError: null,
  });
  audit(req, t, 'exclusion-added', `${user.userPrincipalName} — ${terms.permanent ? 'permanent' : 'until ' + terms.expiresOn}`);
  res.status(201).json({ ok: true });
}));

app.patch('/api/tenants/:tenantId/exclusions/:userId', wrap(async (req, res) => {
  const t = req.tenant.tenantId;
  const ex = store.findExclusion(t, req.params.userId);
  if (!ex) throw bad('Exclusion not tracked', 404);
  const terms = parseTerms(req.body || {});
  const reason = req.body.reason !== undefined ? String(req.body.reason).slice(0, 300) : ex.reason;
  store.upsertExclusion({ tenantId: t, userId: ex.userId, ...terms, reason, lastError: null });
  audit(req, t, 'exclusion-updated', `${ex.upn} — ${terms.permanent ? 'permanent' : 'until ' + terms.expiresOn}`);
  res.json({ ok: true });
}));

app.delete('/api/tenants/:tenantId/exclusions/:userId', wrap(async (req, res) => {
  const t = req.tenant.tenantId;
  if (!GUID.test(req.params.userId)) throw bad('userId must be a GUID');
  const ex = store.findExclusion(t, req.params.userId);
  const policyId = (ex && ex.policyId) || req.tenant.policyId;
  if (policyId) await ca.removeExcludedUser(t, policyId, req.params.userId);
  if (ex) store.deleteExclusion(t, req.params.userId);
  audit(req, t, 'exclusion-removed', ex ? ex.upn : await nameOf(t, req.params.userId));
  res.json({ ok: true });
}));

// ---- Expiry sweeps ---------------------------------------------------------

let sweeping = null; // never run two sweeps at once (a timer tick and a manual click could overlap)
function runSweep() {
  return (sweeping ||= doSweep().finally(() => { sweeping = null; }));
}

async function doSweep() {
  const r = await sweep({ store, removeMember: async (tid, uid, ex) => {
      const policyId = (ex && ex.policyId) || store.getTenant(tid)?.policyId;
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

// Last resort: bad JSON bodies and unexpected errors get a JSON answer, never a stack trace.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Unexpected server error' : err.message });
});

app.listen(cfg.port, cfg.host, () => {
  console.log(`USA-only Conditional Access Exclusion → ${cfg.baseUrl} (listening on ${cfg.host}:${cfg.port})`);
  if (cfg.authDisabled) console.warn('AUTH_DISABLED=true: sign-in is OFF (local development only).');
  else if (!auth.configured()) console.warn('Sign-in is not configured: set PARTNER_TENANT_ID (your bilan.com tenant ID) plus the client ID/secret in .env.');
  if (!['127.0.0.1', 'localhost'].includes(cfg.host) && !cfg.baseUrl.startsWith('https://')) {
    console.warn('Reachable from the network over plain HTTP. Put HTTPS in front of it and set BASE_URL to the https:// address.');
  }
  if (!cfg.clientId || !cfg.clientSecret) console.warn('AZURE_CLIENT_ID / AZURE_CLIENT_SECRET missing — copy .env.example to .env');
  runSweep().catch((e) => console.error('[sweep]', e.message));
  setInterval(() => runSweep().catch((e) => console.error('[sweep]', e.message)), cfg.sweepIntervalMinutes * 60_000);
});

module.exports = { isExpired };
