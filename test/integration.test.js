// End-to-end tests: the real Express app talking to a fake Microsoft Graph.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 39111;
Object.assign(process.env, {
  PORT: String(PORT),
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'caex-int-')),
  AUTH_DISABLED: 'true',
  CAEX_NO_LISTEN: '1',
  AZURE_CLIENT_ID: '11111111-1111-1111-1111-111111111111',
  AZURE_CLIENT_SECRET: 'secret',
  PARTNER_TENANT_ID: '99999999-9999-9999-9999-999999999999',
  APP_TIMEZONE: 'America/New_York',
});

const T = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const NOCONSENT = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'; // tenant that has not approved the app
const P1 = 'b1111111-1111-1111-1111-111111111111';
const P2 = 'b2222222-2222-2222-2222-222222222222';
const U1 = 'c1111111-1111-1111-1111-111111111111'; // already excluded in the policy (outside the app)
const U2 = 'c2222222-2222-2222-2222-222222222222';
const GONE = 'c9999999-9999-9999-9999-999999999999'; // excluded, but the user was deleted
const LOC = 'd1111111-1111-1111-1111-111111111111';

// ---- fake Graph ------------------------------------------------------------
const g = { patches: [], failUsers: null, throttle: 0, pageUsers: false };
function reset() {
  g.patches = [];
  g.failUsers = null;
  g.throttle = 0;
  g.pageUsers = false;
  g.users = {
    [U1]: { id: U1, displayName: 'Uma One', userPrincipalName: 'uma@x.com', accountEnabled: true, userType: 'Member' },
    [U2]: { id: U2, displayName: 'Ted Two', userPrincipalName: 'ted@x.com', accountEnabled: true, userType: 'Member' },
  };
  const mk = (id, name) => ({
    id, displayName: name, state: 'enabled',
    conditions: {
      users: { includeUsers: ['All'], excludeUsers: [U1, GONE], includeGroups: [], excludeGroups: [], includeRoles: [], excludeRoles: ['role-x'], includeGuestsOrExternalUsers: null, excludeGuestsOrExternalUsers: null },
      locations: { includeLocations: ['All'], excludeLocations: [LOC] },
    },
    grantControls: { operator: 'OR', builtInControls: ['block'] },
  });
  g.policies = { [P1]: mk(P1, 'Block non-USA logins'), [P2]: mk(P2, 'Require MFA') };
  g.policies[P2].conditions.locations = {};
  g.policies[P2].grantControls.builtInControls = ['mfa'];
  g.policies[P2].conditions.users.excludeUsers = [];
}
const json = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const gerr = (status, message) => json(status, { error: { code: 'x', message } });

const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith('https://login.microsoftonline.com/' + NOCONSENT)) return json(401, { error: 'invalid_client', error_description: 'AADSTS7000229: The client application is missing service principal in the tenant.' });
  if (url.startsWith('https://login.microsoftonline.com/')) return json(200, { access_token: 'h.' + Buffer.from('{"roles":[]}').toString('base64url') + '.s', expires_in: 3600 });
  if (!url.startsWith('https://graph.microsoft.com/v1.0')) return realFetch(url, opts);
  const u = new URL(url);
  const p = u.pathname.replace('/v1.0', '');
  const method = opts.method || 'GET';
  let m;
  if (g.throttle > 0) { g.throttle--; return new Response('{}', { status: 429, headers: { 'retry-after': '0' } }); }
  if (p === '/identity/conditionalAccess/policies' && method === 'GET') return json(200, { value: Object.values(g.policies) });
  if (p === '/identity/conditionalAccess/namedLocations') return json(200, { value: [{ id: LOC, displayName: 'USA', '@odata.type': '#microsoft.graph.countryNamedLocation', countriesAndRegions: ['US'] }] });
  if ((m = /^\/identity\/conditionalAccess\/policies\/([^/]+)$/.exec(p))) {
    const pol = g.policies[m[1]];
    if (!pol) return gerr(404, 'not found');
    if (method === 'GET') { await new Promise((r) => setTimeout(r, 5)); return json(200, structuredClone(pol)); }
    if (method === 'PATCH') {
      const body = JSON.parse(opts.body);
      g.patches.push({ id: m[1], body });
      if (body.state) pol.state = body.state;
      if (body.conditions?.users) {
        if (Object.values(body.conditions.users).some((v) => v === null)) return gerr(400, 'null not accepted');
        pol.conditions.users = { ...pol.conditions.users, ...body.conditions.users };
      }
      return json(204, null);
    }
  }
  if ((m = /^\/users\/([^/]+)$/.exec(p))) {
    if (g.failUsers) return gerr(g.failUsers, 'Insufficient privileges');
    return g.users[m[1]] ? json(200, g.users[m[1]]) : gerr(404, 'user not found');
  }
  if (p === '/users') {
    const all = Object.values(g.users);
    if (!g.pageUsers) return json(200, { value: all });
    return u.searchParams.get('page') === '2'
      ? json(200, { value: all.slice(1) })
      : json(200, { value: all.slice(0, 1), '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?page=2' });
  }
  if (p === '/auditLogs/signIns') return json(200, { value: [{ createdDateTime: '2026-11-08T10:00:00Z', location: { countryOrRegion: 'MX', city: 'Cancun' }, ipAddress: '1.2.3.4', appDisplayName: 'Outlook', status: { errorCode: 0 } }] });
  return gerr(500, `fake graph: unhandled ${method} ${p}`);
};

// ---- app -------------------------------------------------------------------
const { app, store, runSweep } = require('../server');
let server;
const call = async (method, url, body) => {
  const res = await realFetch(`http://localhost:${PORT}${url}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const excludedIn = (pid) => g.policies[pid].conditions.users.excludeUsers;

test.before(() => new Promise((r) => { server = app.listen(PORT, '127.0.0.1', r); }));
test.after(() => server.close());
test.beforeEach(() => reset());

test('full flow: add tenant, discover and pick policy, see existing exclusions', async () => {
  assert.equal((await call('POST', '/api/tenants', { name: 'Acme', tenantId: T })).status, 201);
  assert.equal((await call('GET', `/api/tenants/${T}/status`)).body.needsPolicy, true);

  const pols = (await call('GET', `/api/tenants/${T}/policies`)).body;
  assert.equal(pols[0].id, P1, 'the US-only block policy ranks first');
  assert.equal(pols[0].rank, 2);

  assert.equal((await call('POST', `/api/tenants/${T}/policy/select`, { policyId: P1 })).status, 200);
  assert.equal(g.patches.length, 0, 'choosing a policy must not modify the tenant');

  const st = (await call('GET', `/api/tenants/${T}/status`)).body;
  assert.equal(st.ready, true);
  assert.deepEqual(st.untracked.map((x) => x.id).sort(), [U1, GONE].sort());
  assert.equal(st.untracked.find((x) => x.id === GONE).displayName, '(deleted user)');
  assert.equal(st.exclusions.length, 0);
});

test('add exclusion patches only the users condition and keeps other settings', async () => {
  const r = await call('POST', `/api/tenants/${T}/exclusions`, { userId: U2, permanent: false, expiresOn: '2099-01-01', reason: 'trip' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(excludedIn(P1), [U1, GONE, U2]);
  const sent = g.patches.at(-1).body;
  assert.deepEqual(Object.keys(sent), ['conditions']);
  assert.deepEqual(Object.keys(sent.conditions), ['users']);
  assert.deepEqual(sent.conditions.users.excludeRoles, ['role-x'], 'existing exclusions of other kinds are preserved');
  assert.deepEqual(g.policies[P1].conditions.locations.excludeLocations, [LOC]);

  const st = (await call('GET', `/api/tenants/${T}/status`)).body;
  assert.equal(st.exclusions.length, 1);
  assert.equal(st.exclusions[0].inPolicy, true);
  assert.equal(st.exclusions[0].policyId, P1);
  assert.equal(st.audit[0].action, 'exclusion-added');
});

test('validation: past date, impossible date, missing date, unknown user', async () => {
  const post = (b) => call('POST', `/api/tenants/${T}/exclusions`, { userId: U1, ...b });
  assert.equal((await post({ permanent: false, expiresOn: '2020-01-01' })).status, 400);
  assert.equal((await post({ permanent: false, expiresOn: '2099-02-31' })).status, 400);
  assert.equal((await post({ permanent: false })).status, 400);
  assert.equal((await call('POST', `/api/tenants/${T}/exclusions`, { userId: 'c7777777-7777-7777-7777-777777777777', permanent: true })).status, 404);
  assert.deepEqual(excludedIn(P1), [U1, GONE], 'nothing was excluded by rejected requests');
});

test('tracking an existing exclusion does not patch the policy; editing terms works', async () => {
  const r = await call('POST', `/api/tenants/${T}/exclusions`, { userId: U1, permanent: true });
  assert.equal(r.status, 201);
  assert.equal(g.patches.length, 0, 'user was already excluded');
  assert.equal((await call('PATCH', `/api/tenants/${T}/exclusions/${U1}`, { permanent: false, expiresOn: '2099-05-05' })).status, 200);
  assert.equal(store.findExclusion(T, U1).expiresOn, '2099-05-05');
  assert.equal(store.findExclusion(T, U1).permanent, false);
});

test('removing an untracked deleted user works and logs a readable name', async () => {
  const r = await call('DELETE', `/api/tenants/${T}/exclusions/${GONE}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!excludedIn(P1).includes(GONE));
  const st = (await call('GET', `/api/tenants/${T}/status`)).body;
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(st.audit[0].detail), `no raw IDs in the log: ${st.audit[0].detail}`);
});

test('expiry sweep removes only expired exclusions from the policy', async () => {
  store.upsertExclusion({ tenantId: T, userId: U2, upn: 'ted@x.com', permanent: false, expiresOn: '2020-01-01', policyId: P1 });
  g.policies[P1].conditions.users.excludeUsers = [U1, U2];
  const r = await runSweep();
  assert.equal(r.removed.length, 1);
  assert.deepEqual(excludedIn(P1), [U1], 'the permanent/untracked user stays');
  assert.equal(store.findExclusion(T, U2), undefined);
});

test('after changing policy, an old exclusion is removed from the policy it was added to', async () => {
  store.upsertExclusion({ tenantId: T, userId: U2, upn: 'ted@x.com', permanent: false, expiresOn: '2020-01-01', policyId: P1 });
  g.policies[P1].conditions.users.excludeUsers = [U1, U2];
  await call('DELETE', `/api/tenants/${T}/policy/select`);
  await call('POST', `/api/tenants/${T}/policy/select`, { policyId: P2 });

  const st = (await call('GET', `/api/tenants/${T}/status`)).body;
  assert.equal(st.exclusions[0].otherPolicy, true);
  const again = await call('POST', `/api/tenants/${T}/exclusions`, { userId: U2, permanent: true });
  assert.equal(again.status, 409, 'cannot silently move a tracked exclusion to the new policy');

  await runSweep();
  assert.deepEqual(excludedIn(P1), [U1], 'removed from the OLD policy');
  await call('POST', `/api/tenants/${T}/policy/select`, { policyId: P1 }); // restore for later tests
});

test('a permission failure is reported, not shown as "deleted users"', async () => {
  g.failUsers = 403;
  const r = await call('GET', `/api/tenants/${T}/status`);
  assert.equal(r.status, 403, JSON.stringify(r.body));
});

test('sign-ins, policy state, and removing the tenant', async () => {
  const s = await call('GET', `/api/tenants/${T}/signins/${U1}`);
  assert.equal(s.body[0].country, 'MX');
  assert.equal((await call('PATCH', `/api/tenants/${T}/policy`, { state: 'reportOnly' })).status, 200);
  assert.equal(g.policies[P1].state, 'enabledForReportingButNotEnforced');
  assert.equal((await call('PATCH', `/api/tenants/${T}/policy`, { state: 'bogus' })).status, 400);

  store.upsertExclusion({ tenantId: T, userId: U1, upn: 'uma@x.com', permanent: true, policyId: P1 });
  assert.equal((await call('DELETE', `/api/tenants/${T}`)).status, 409, 'tracked exclusions need an explicit force');
  assert.equal((await call('DELETE', `/api/tenants/${T}`, { force: true })).status, 200);
  assert.equal((await call('GET', `/api/tenants/${T}/status`)).status, 404);
  assert.deepEqual(excludedIn(P1), [U1, GONE], 'removing a tenant from the app never touches the policy');
});

test('two people adding exclusions at the same moment: neither is lost', async () => {
  await call('POST', '/api/tenants', { name: 'Acme', tenantId: T });
  await call('POST', `/api/tenants/${T}/policy/select`, { policyId: P1 });
  g.users.c3 = null;
  const U3 = 'c3333333-3333-3333-3333-333333333333';
  g.users[U3] = { id: U3, displayName: 'Tia Three', userPrincipalName: 'tia@x.com' };
  const [a, b] = await Promise.all([
    call('POST', `/api/tenants/${T}/exclusions`, { userId: U2, permanent: true }),
    call('POST', `/api/tenants/${T}/exclusions`, { userId: U3, permanent: true }),
  ]);
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  assert.ok(excludedIn(P1).includes(U2) && excludedIn(P1).includes(U3), `both present: ${excludedIn(P1)}`);
  store.deleteExclusion(T, U2); store.deleteExclusion(T, U3);
});

test('Graph throttling (429) is retried; paged user lists are followed', async () => {
  g.throttle = 2;
  g.pageUsers = true;
  const r = await call('GET', `/api/tenants/${T}/users`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.length, 2);
});

test('a deleted policy is reported and expiry does not crash', async () => {
  store.upsertExclusion({ tenantId: T, userId: U2, upn: 'ted@x.com', permanent: false, expiresOn: '2020-01-01', policyId: P1 });
  delete g.policies[P1];
  const st = (await call('GET', `/api/tenants/${T}/status`)).body;
  assert.equal(st.ready, false);
  assert.match(st.drift[0], /no longer exists/);
  const r = await runSweep();
  assert.equal(r.failed.length, 0);
  assert.equal(store.findExclusion(T, U2), undefined);
});

test('when Graph is down, an expired exclusion is kept and retried later', async () => {
  store.upsertExclusion({ tenantId: T, userId: U2, upn: 'ted@x.com', permanent: false, expiresOn: '2020-01-01', policyId: P1 });
  g.policies[P1].conditions.users.excludeUsers = [U2];
  const orig = g.policies; g.policies = new Proxy({}, { get() { throw new Error('boom'); } });
  const r1 = await runSweep().catch((e) => ({ threw: e.message }));
  g.policies = orig;
  assert.ok(store.findExclusion(T, U2), `record kept after failure: ${JSON.stringify(r1)}`);
  const r2 = await runSweep();
  assert.equal(r2.removed.length, 1);
});

test('a tenant that has not approved the app gets a readable error, never a 401 (which would bounce the page to sign-in)', async () => {
  assert.equal((await call('POST', '/api/tenants', { name: 'New Co', tenantId: NOCONSENT })).status, 201);
  const r = await call('GET', `/api/tenants/${NOCONSENT}/policies`);
  assert.notEqual(r.status, 401);
  assert.equal(r.status, 502);
  assert.match(r.body.error, /has an admin granted consent/);
  const list = (await call('GET', '/api/tenants')).body.tenants.find((x) => x.tenantId === NOCONSENT);
  assert.match(list.consentUrl, new RegExp(`login.microsoftonline.com/${NOCONSENT}/adminconsent`));
});
