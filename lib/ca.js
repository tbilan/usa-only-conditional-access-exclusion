const { graph, graphAll } = require('./graph');

const POLICY_NAME = 'USA-only Conditional Access';
const GROUP_NAME = 'USA-only CA Exclusions';
const LOCATION_NAME = 'Allowed - United States';

const POLICY_STATES = {
  reportOnly: 'enabledForReportingButNotEnforced',
  on: 'enabled',
  off: 'disabled',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findLocation(t) {
  const list = await graphAll(t, '/identity/conditionalAccess/namedLocations');
  return (
    list.find(
      (l) => l.displayName === LOCATION_NAME && l['@odata.type'] === '#microsoft.graph.countryNamedLocation'
    ) || null
  );
}

async function findPolicy(t) {
  const list = await graphAll(t, '/identity/conditionalAccess/policies');
  return list.find((p) => p.displayName === POLICY_NAME) || null;
}

async function findGroup(t) {
  const filter = encodeURIComponent(`displayName eq '${GROUP_NAME}'`);
  const r = await graph(t, 'GET', `/groups?$filter=${filter}&$select=id,displayName`);
  return r.value[0] || null;
}

async function listMembers(t, groupId) {
  return graphAll(t, `/groups/${groupId}/members?$select=id,displayName,userPrincipalName&$top=999`);
}

/** Everything the UI needs about one tenant. */
async function getStatus(t) {
  const [policy, group, location] = await Promise.all([findPolicy(t), findGroup(t), findLocation(t)]);
  const members = group ? await listMembers(t, group.id) : [];
  const drift = [];
  if (policy && group && !(policy.conditions?.users?.excludeGroups || []).includes(group.id)) {
    drift.push('Policy does not exclude the exclusions group');
  }
  if (policy && location && !(policy.conditions?.locations?.excludeLocations || []).includes(location.id)) {
    drift.push('Policy does not exclude the United States location');
  }
  return {
    policy: policy && { id: policy.id, state: policy.state, modified: policy.modifiedDateTime },
    group: group && { id: group.id, displayName: group.displayName },
    location: location && { id: location.id, displayName: location.displayName },
    members,
    drift,
    provisioned: !!(policy && group && location),
  };
}

/** Idempotently create the US named location, exclusions group, and block policy. */
async function provision(t, stateKey = 'reportOnly') {
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

  let group = await findGroup(t);
  if (!group) {
    group = await graph(t, 'POST', '/groups', {
      body: {
        displayName: GROUP_NAME,
        description: 'Managed by USA-only Conditional Access Exclusion. Members are exempt from the US-only block policy.',
        mailEnabled: false,
        mailNickname: 'usa-only-ca-exclusions',
        securityEnabled: true,
      },
    });
  }

  let policy = await findPolicy(t);
  if (!policy) {
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
    // A brand-new group can take a few seconds to replicate before a policy may reference it.
    for (let attempt = 0; ; attempt++) {
      try {
        policy = await graph(t, 'POST', '/identity/conditionalAccess/policies', { body });
        break;
      } catch (e) {
        if (attempt >= 5 || e.status !== 400) throw e;
        await sleep(4000);
      }
    }
  } else {
    // Repair drift on an existing policy (only touches the users condition).
    const users = policy.conditions?.users || {};
    const groups = new Set(users.excludeGroups || []);
    if (!groups.has(group.id)) {
      groups.add(group.id);
      await graph(t, 'PATCH', `/identity/conditionalAccess/policies/${policy.id}`, {
        body: { conditions: { users: { ...users, excludeGroups: [...groups] } } },
      });
    }
  }
  return { policyId: policy.id, groupId: group.id, locationId: location.id };
}

async function setPolicyState(t, stateKey) {
  const state = POLICY_STATES[stateKey];
  if (!state) throw new Error('Unknown policy state');
  const policy = await findPolicy(t);
  if (!policy) throw Object.assign(new Error('Policy not provisioned yet'), { status: 409 });
  await graph(t, 'PATCH', `/identity/conditionalAccess/policies/${policy.id}`, { body: { state } });
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
  POLICY_NAME, GROUP_NAME, LOCATION_NAME,
  findGroup, getStatus, provision, setPolicyState,
  addMember, removeMember, removeMemberByTenant, listUsers, getUser,
};
