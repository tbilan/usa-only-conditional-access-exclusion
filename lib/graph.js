const cfg = require('./config');

const BASE = 'https://graph.microsoft.com/v1.0';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class GraphError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const tokenCache = new Map(); // tenantId -> { token, expires }

const REQUIRED_ROLES = [
  'Policy.ReadWrite.ConditionalAccess',
  'Policy.Read.All',
  'Application.Read.All',
  'Group.ReadWrite.All',
  'User.Read.All',
];

/** Application roles (permissions) actually present in an access token. */
function tokenRoles(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).roles || [];
  } catch {
    return [];
  }
}

async function getToken(tenantId) {
  if (!GUID.test(tenantId)) throw new GraphError(400, 'BadTenant', 'Tenant ID must be a GUID');
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new GraphError(500, 'NotConfigured', 'AZURE_CLIENT_ID / AZURE_CLIENT_SECRET are not set in .env');
  }
  const cached = tokenCache.get(tenantId);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint = /AADSTS700016|AADSTS65001|AADSTS500011|AADSTS7000229/.test(json.error_description || '')
      ? ' (has an admin granted consent to this app in that tenant?)'
      : '';
    throw new GraphError(res.status, json.error || 'TokenError', `Token request failed: ${json.error_description || res.statusText}${hint}`);
  }
  tokenCache.set(tenantId, { token: json.access_token, expires: Date.now() + json.expires_in * 1000 });
  return json.access_token;
}

async function graph(tenantId, method, pathOrUrl, { body, headers = {} } = {}, attempt = 0) {
  const token = await getToken(tenantId);
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 4) {
    const wait = (parseInt(res.headers.get('retry-after') || '0', 10) || 2 ** attempt) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return graph(tenantId, method, pathOrUrl, { body, headers }, attempt + 1);
  }
  if (res.status === 204) return null;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = json && json.error ? json.error : {};
    let message = e.message || res.statusText;
    if (res.status === 403) {
      // Drop the cached token so a re-consent takes effect without restarting, and say what is missing.
      tokenCache.delete(tenantId);
      const have = tokenRoles(token);
      const missing = REQUIRED_ROLES.filter((r) => !have.includes(r));
      if (missing.length) {
        message += ` — This tenant's token is missing: ${missing.join(', ')}. Add them as Application permissions on the app registration, grant consent, then have an admin of this tenant re-approve the consent link.`;
      }
    }
    throw new GraphError(res.status, e.code || 'GraphError', message);
  }
  return json;
}

async function graphAll(tenantId, path, { max = 10000 } = {}) {
  const out = [];
  let next = path;
  while (next && out.length < max) {
    const page = await graph(tenantId, 'GET', next);
    out.push(...(page.value || []));
    next = page['@odata.nextLink'];
  }
  return out;
}

module.exports = { graph, graphAll, GraphError, GUID, BASE };
