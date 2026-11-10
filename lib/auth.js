const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const cfg = require('./config');

const b64 = (b) => Buffer.from(b).toString('base64url');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const secure = cfg.baseUrl.startsWith('https://');
const SESSION_COOKIE = 'caex_session';
const TX_COOKIE = 'caex_login';

// Signing key for cookies: SESSION_SECRET, or a random one generated once and kept in data/.
function loadSecret() {
  if (cfg.sessionSecret) return cfg.sessionSecret;
  const file = path.join(cfg.dataDir, 'session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, s, { mode: 0o600 });
    return s;
  }
}
let secret;
const key = () => (secret ||= loadSecret());

/** Signed, expiring token: base64url(json).hmac */
function sign(payload, ttlSeconds) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  return `${body}.${crypto.createHmac('sha256', key()).update(body).digest('base64url')}`;
}

function verify(token) {
  if (typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const good = crypto.createHmac('sha256', key()).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() / 1000 ? p : null;
  } catch {
    return null;
  }
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed cookie */ }
    }
  }
  return out;
}

function setCookie(res, name, value, maxAgeSeconds) {
  res.append('Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`);
}

const authority = () => `https://login.microsoftonline.com/${cfg.partnerTenantId}`;
const redirectUri = () => `${cfg.baseUrl}/auth/callback`;
let jwks;

function configured() {
  return !!(cfg.clientId && cfg.clientSecret && cfg.partnerTenantId);
}

/** Express middleware + routes for Entra ID (bilan.com only) sign-in using the auth-code + PKCE flow. */
function install(app) {
  const PUBLIC = new Set(['/healthz', '/auth/login', '/auth/callback', '/signed-out.html', '/consent-done.html', '/style.css']);

  app.get('/auth/login', (req, res) => {
    if (!configured()) {
      return res.status(500).send('Sign-in is not configured: set AZURE_CLIENT_ID, AZURE_CLIENT_SECRET and PARTNER_TENANT_ID (your bilan.com tenant ID) in .env.');
    }
    const state = crypto.randomBytes(16).toString('hex');
    const nonce = crypto.randomBytes(16).toString('hex');
    const verifier = crypto.randomBytes(32).toString('base64url');
    setCookie(res, TX_COOKIE, sign({ state, nonce, verifier }, 600), 600);
    const q = new URLSearchParams({
      client_id: cfg.clientId,
      response_type: 'code',
      redirect_uri: redirectUri(),
      response_mode: 'query',
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    res.redirect(`${authority()}/oauth2/v2.0/authorize?${q}`);
  });

  app.get('/auth/callback', async (req, res) => {
    const fail = (msg, status = 400) => res.status(status).send(`Sign-in failed: ${esc(msg)}. <a href="/auth/login">Try again</a>`); // msg can come from the URL: always escape
    try {
      if (req.query.error) return fail(String(req.query.error_description || req.query.error).slice(0, 300));
      const tx = verify(cookies(req)[TX_COOKIE]);
      if (!tx || !req.query.code || req.query.state !== tx.state) return fail('login session expired or invalid');

      const tokenRes = await fetch(`${authority()}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          grant_type: 'authorization_code',
          code: String(req.query.code),
          redirect_uri: redirectUri(),
          code_verifier: tx.verifier,
        }),
      });
      const tok = await tokenRes.json();
      if (!tokenRes.ok || !tok.id_token) return fail(tok.error_description ? tok.error_description.split('\r')[0] : 'token exchange failed');

      jwks ||= createRemoteJWKSet(new URL(`${authority()}/discovery/v2.0/keys`));
      const { payload } = await jwtVerify(tok.id_token, jwks, {
        audience: cfg.clientId,
        issuer: `${authority()}/v2.0`,
      });
      if (payload.nonce !== tx.nonce) return fail('nonce mismatch');
      if (String(payload.tid).toLowerCase() !== cfg.partnerTenantId.toLowerCase()) return fail('not a bilan.com account', 403);

      setCookie(res, SESSION_COOKIE, sign({
        oid: payload.oid,
        name: payload.name || payload.preferred_username,
        upn: payload.preferred_username || payload.email || payload.upn || payload.oid,
      }, cfg.sessionHours * 3600), cfg.sessionHours * 3600);
      setCookie(res, TX_COOKIE, '', 0);
      res.redirect('/');
    } catch (e) {
      fail(e.message, 500);
    }
  });

  app.post('/auth/logout', (req, res) => {
    setCookie(res, SESSION_COOKIE, '', 0);
    res.json({ ok: true });
  });

  // Everything below this point requires a signed-in bilan.com user.
  app.use((req, res, next) => {
    if (cfg.authDisabled) { req.user = { name: 'Local (auth disabled)', upn: 'local' }; return next(); }
    if (PUBLIC.has(req.path)) return next();
    const user = verify(cookies(req)[SESSION_COOKIE]);
    if (user) { req.user = user; return next(); }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in', login: '/auth/login' });
    return res.redirect('/auth/login');
  });

  app.get('/api/me', (req, res) => res.json({ name: req.user.name, upn: req.user.upn }));
}

module.exports = { install, sign, verify, configured };
