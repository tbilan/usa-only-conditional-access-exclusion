const { graph, graphAll } = require('./graph');

const POLICY_NAME = 'USA-only Conditional Access'; // only used when creating a NEW policy
const LOCATION_NAME = 'Allowed - United States';

const POLICY_STATES = {
  reportOnly: 'enabledForReportingButNotEnforced',
  on: 'enabled',
  off: 'disabled',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLICIES = '/identity/conditionalAccess/policies';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The policy's excluded-user list is edited read-modify-write, so serialize edits per tenant.
const locks = new Map();
function withLock(tenantId, fn) {
  const prev = locks.get(tenantId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(tenantId, next);
  return next;
}

/**
 * Every Conditional Access policy in the tenant, summarized for a picklist.
 * `rank` 2 = blocks and references a US country location, 1 = blocks and has a location
 * condition, 0 = other. Sorted best match first.
 */
async function listPolicies(t) {
  const [policies, locations] = await Promise.all([
    graphAll(t, POLICIES),
    graphAll(t, '/identity/conditionalAccess/namedLocations'),
  ]);
  const locMap = new Map(locations.map((l) => [l.id, l]));
  const locName = (id) => {
    if (id === 'All') return 'All locations';
    if (id === 'AllTrusted') return 'All trusted locations';
    const l = locMap.get(id);
    if (!l) return id;
    const c = l.countriesAndRegions ? ` (${l.countriesAndRegions.join(', ')})` : '';
    return l.displayName + c;
  };
  const isUS = (id) => !!locMap.get(id)?.countriesAndRegions?.includes('US');

  return policies
    .map((p) => {
      const loc = p.conditions?.locations || {};
      const inc = loc.includeLocations || [];
      const exc = loc.excludeLocations || [];
      const blocks = (p.grantControls?.builtInControls || []).includes('block');
      const usRef = [...inc, ...exc].some(isUS);
      const hasLocationCondition = exc.length > 0 || inc.some((i) => i !== 'All');
      const users = p.conditions?.users || {};
      return {
        id: p.id,
        displayName: p.displayName,
        state: p.state,
        blocks,
        includeLocations: inc.map(locName),
        excludeLocations: exc.map(locName),
        appliesTo: (users.includeUsers || []).includes('All') ? 'All users' : 'Selected users/groups/roles',
        excludedUserCount: (users.excludeUsers || []).filter((u) => GUID.test(u)).length,
        rank: blocks && usRef ? 2 : blocks && hasLocationCondition ? 1 : 0,
      };
    })
    .sort((a, b) => b.rank - a.rank || a.displayName.localeCompare(b.displayName));
}

async function getPolicy(t, policyId) {
  try {
    return await graph(t, 'GET', `${POLICIES}/${encodeURIComponent(policyId)}`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function findLocation(t) {
  const list = await graphAll(t, '/identity/conditionalAccess/namedLocations');
  return (
    list.find((l) => l.displayName === LOCATION_NAME && l['@odata.type'] === '#microsoft.graph.countryNamedLocation') || null
  );
}

/** Resolve user IDs to names (a few at a time). Unresolvable IDs (deleted users) keep just the ID. */
async function resolveUsers(t, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const got = await Promise.all(
      chunk.map((id) =>
        graph(t, 'GET', `/users/${id}?$select=id,displayName,userPrincipalName`).catch(() => ({ id, displayName: '(unknown or deleted user)', userPrincipalName: id }))
      )
    );
    out.push(...got);
  }
  return out;
}

/** The chosen policy and the users currently excluded from it. */
async function getStatus(t, policyId) {
  const policy = await getPolicy(t, policyId);
  const ids = ((policy && policy.conditions?.users?.excludeUsers) || []).filter((u) => GUID.test(u));
  const excluded = policy ? await resolveUsers(t, ids) : [];
  return {
    policy: policy && { id: policy.id, displayName: policy.displayName, state: policy.state, modified: policy.modifiedDateTime },
    excluded,
    drift: policy ? [] : ['The selected policy no longer exists in this tenant'],
    ready: !!policy,
  };
}

/** Patch only the users condition, dropping null/empty fields Graph returned but may not accept back. */
async function patchUsers(t, policyId, users) {
  const clean = Object.fromEntries(Object.entries(users).filter(([, v]) => v !== null && v !== undefined));
  await graph(t, 'PATCH', `${POLICIES}/${policyId}`, { body: { conditions: { users: clean } } });
}

/** Add a user to the policy's Exclude → Users list. No-op if already there. */
function addExcludedUser(t, policyId, userId) {
  return withLock(t, async () => {
    const policy = await getPolicy(t, policyId);
    if (!policy) throw Object.assign(new Error('Policy not found in this tenant'), { status: 404 });
    const users = policy.conditions?.users || {};
    const list = users.excludeUsers || [];
    if (list.some((u) => u.toLowerCase() === userId.toLowerCase())) return;
    await patchUsers(t, policyId, { ...users, excludeUsers: [...list, userId] });
  });
}

/** Remove a user from the policy's Exclude → Users list. No-op if not there. */
function removeExcludedUser(t, policyId, userId) {
  return withLock(t, async () => {
    const policy = await getPolicy(t, policyId);
    if (!policy) return; // policy gone: nothing to remove from
    const users = policy.conditions?.users || {};
    const list = users.excludeUsers || [];
    const next = list.filter((u) => u.toLowerCase() !== userId.toLowerCase());
    if (next.length === list.length) return;
    await patchUsers(t, policyId, { ...users, excludeUsers: next });
  });
}

/** Create a brand-new US-only block policy (for tenants that don't have one). */
async function createPolicy(t, stateKey = 'reportOnly') {
  const state = POLICY_STATES[stateKey];
  if (!state) throw new Error('Unknown policy state');

  let location = await findLocation(t);
  if (!location) {
    location = await graph(t, 'POST', '/identity/conditionalAccess/namedLocations', {
      body: {
        '@odata.type': '#microsoft.graph.countryNamedLocation',
        displayName: LOCATION_NAME,
        countriesAndRegions: ['US'],
        includeUnknownCountriesAndRegions: false,
      },
    });
  }
  const policy = await graph(t, 'POST', POLICIES, {
    body: {
      displayName: POLICY_NAME,
      state,
      conditions: {
        clientAppTypes: ['all'],
        applications: { includeApplications: ['All'] },
        users: { includeUsers: ['All'] },
        locations: { includeLocations: ['All'], excludeLocations: [location.id] },
      },
      grantControls: { operator: 'OR', builtInControls: ['block'] },
    },
  });
  return { policyId: policy.id, policyName: policy.displayName };
}

async function setPolicyState(t, policyId, stateKey) {
  const state = POLICY_STATES[stateKey];
  if (!state) throw new Error('Unknown policy state');
  await graph(t, 'PATCH', `${POLICIES}/${policyId}`, { body: { state } });
}

async function listUsers(t) {
  const users = await graphAll(
    t,
    '/users?$select=id,displayName,userPrincipalName,accountEnabled,userType&$top=999',
    { max: 5000 }
  );
  return users
    .map((u) => ({
      id: u.id,
      displayName: u.displayName || u.userPrincipalName,
      upn: u.userPrincipalName,
      enabled: u.accountEnabled,
      userType: u.userType,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

async function getUser(t, userId) {
  return graph(t, 'GET', `/users/${encodeURIComponent(userId)}?$select=id,displayName,userPrincipalName`);
}

/** The user's most recent sign-ins (interactive) with their country, newest first. */
async function recentSignIns(t, userId, n = 5) {
  const filter = encodeURIComponent(`userId eq '${userId}'`);
  const order = encodeURIComponent('createdDateTime desc');
  const r = await graph(t, 'GET', `/auditLogs/signIns?$filter=${filter}&$orderby=${order}&$top=${n}`);
  return (r.value || []).map((x) => ({
    at: x.createdDateTime,
    country: x.location?.countryOrRegion || null,
    city: x.location?.city || null,
    ip: x.ipAddress,
    app: x.appDisplayName,
    ok: x.status?.errorCode === 0,
  }));
}

module.exports = {
  recentSignIns, listPolicies, getPolicy, getStatus, createPolicy, setPolicyState,
  addExcludedUser, removeExcludedUser, listUsers, getUser,
};
