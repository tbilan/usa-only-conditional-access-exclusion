const { graph, graphAll } = require('./graph');

const POLICY_NAME = 'USA-only Conditional Access'; // only used when creating a NEW policy
const GROUP_NAME = 'USA-only CA Exclusions';
const LOCATION_NAME = 'Allowed - United States';

const POLICY_STATES = {
  reportOnly: 'enabledForReportingButNotEnforced',
  on: 'enabled',
  off: 'disabled',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLICIES = '/identity/conditionalAccess/policies';

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
        excludedGroupCount: (users.excludeGroups || []).length,
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

async function findGroup(t) {
  const filter = encodeURIComponent(`displayName eq '${GROUP_NAME}'`);
  const r = await graph(t, 'GET', `/groups?$filter=${filter}&$select=id,displayName`);
  return r.value[0] || null;
}

async function ensureGroup(t) {
  return (
    (await findGroup(t)) ||
    graph(t, 'POST', '/groups', {
      body: {
        displayName: GROUP_NAME,
        description: 'Managed by USA-only Conditional Access Exclusion. Members are exempt from the US-only policy.',
        mailEnabled: false,
        mailNickname: 'usa-only-ca-exclusions',
        securityEnabled: true,
      },
    })
  );
}

async function listMembers(t, groupId) {
  return graphAll(t, `/groups/${groupId}/members?$select=id,displayName,userPrincipalName&$top=999`);
}

/** Status of the tenant's chosen policy plus the exclusions group. */
async function getStatus(t, policyId) {
  const [policy, group] = await Promise.all([getPolicy(t, policyId), findGroup(t)]);
  const members = group ? await listMembers(t, group.id) : [];
  const drift = [];
  if (!policy) drift.push('The selected policy no longer exists in this tenant');
  else if (group && !(policy.conditions?.users?.excludeGroups || []).includes(group.id)) {
    drift.push('The policy does not exclude the exclusions group');
  }
  if (policy && !group) drift.push('The exclusions group is missing');
  return {
    policy: policy && { id: policy.id, displayName: policy.displayName, state: policy.state, modified: policy.modifiedDateTime },
    group: group && { id: group.id, displayName: group.displayName },
    members,
    drift,
    ready: !!(policy && group && drift.length === 0),
  };
}

/**
 * Point an EXISTING policy at the exclusions group: create the group if needed and add it to the
 * policy's excluded groups. Nothing else on the policy is changed.
 */
async function attachGroup(t, policyId) {
  const policy = await getPolicy(t, policyId);
  if (!policy) throw Object.assign(new Error('Policy not found in this tenant'), { status: 404 });
  const group = await ensureGroup(t);

  const users = policy.conditions?.users || {};
  const groups = new Set(users.excludeGroups || []);
  if (!groups.has(group.id)) {
    groups.add(group.id);
    const body = { conditions: { users: { ...users, excludeGroups: [...groups] } } };
    // A brand-new group can take a few seconds to replicate before a policy may reference it.
    for (let attempt = 0; ; attempt++) {
      try {
        await graph(t, 'PATCH', `${POLICIES}/${policyId}`, { body });
        break;
      } catch (e) {
        if (attempt >= 5 || e.status !== 400) throw e;
        await sleep(4000);
      }
    }
  }
  return { policyId: policy.id, policyName: policy.displayName, groupId: group.id };
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
  const group = await ensureGroup(t);
  const body = {
    displayName: POLICY_NAME,
    state,
    conditions: {
      clientAppTypes: ['all'],
      applications: { includeApplications: ['All'] },
      users: { includeUsers: ['All'], excludeGroups: [group.id] },
      locations: { includeLocations: ['All'], excludeLocations: [location.id] },
    },
    grantControls: { operator: 'OR', builtInControls: ['block'] },
  };
  let policy;
  for (let attempt = 0; ; attempt++) {
    try {
      policy = await graph(t, 'POST', POLICIES, { body });
      break;
    } catch (e) {
      if (attempt >= 5 || e.status !== 400) throw e;
      await sleep(4000);
    }
  }
  return { policyId: policy.id, policyName: policy.displayName, groupId: group.id };
}

async function setPolicyState(t, policyId, stateKey) {
  const state = POLICY_STATES[stateKey];
  if (!state) throw new Error('Unknown policy state');
  await graph(t, 'PATCH', `${POLICIES}/${policyId}`, { body: { state } });
}

async function addMember(t, groupId, userId) {
  try {
    await graph(t, 'POST', `/groups/${groupId}/members/$ref`, {
      body: { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}` },
    });
  } catch (e) {
    if (e.status === 400 && /already exist/i.test(e.message)) return; // already a member
    throw e;
  }
}

async function removeMember(t, groupId, userId) {
  try {
    await graph(t, 'DELETE', `/groups/${groupId}/members/${userId}/$ref`);
  } catch (e) {
    if (e.status === 404) return; // already gone
    throw e;
  }
}

async function removeMemberByTenant(t, userId) {
  const group = await findGroup(t);
  if (!group) return;
  await removeMember(t, group.id, userId);
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

module.exports = {
  GROUP_NAME,
  listPolicies, findGroup, getStatus, attachGroup, createPolicy, setPolicyState,
  addMember, removeMember, removeMemberByTenant, listUsers, getUser,
};
