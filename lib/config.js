require('dotenv').config();

// Blank out the unedited placeholder values copied from .env.example.
const real = (v) => (v && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v) && v !== 'your-client-secret-value' ? v : '');

// Parse a positive integer setting; a typo must not become NaN (NaN would break cookies and timers).
function int(value, fallback, min = 1) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

const port = int(process.env.PORT, 3000);
const onAzure = !!process.env.WEBSITE_HOSTNAME; // set by Azure App Service

// Calendar dates ("remove after ...") are evaluated in this time zone. Azure App Service runs in UTC,
// so set APP_TIMEZONE (an IANA name such as America/New_York) there.
const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
let timezone = process.env.APP_TIMEZONE || systemTz;
try { new Intl.DateTimeFormat('en-CA', { timeZone: timezone }); } catch {
  console.warn(`APP_TIMEZONE "${timezone}" is not a valid time zone; using ${systemTz}.`);
  timezone = systemTz;
}

// Lower-case host so the sign-in redirect URI always matches what is registered.
let baseUrl = process.env.BASE_URL || (onAzure ? `https://${process.env.WEBSITE_HOSTNAME}` : `http://localhost:${port}`);
try { baseUrl = new URL(baseUrl).origin; } catch {
  console.warn(`BASE_URL "${baseUrl}" is not a valid URL; using http://localhost:${port}.`);
  baseUrl = `http://localhost:${port}`;
}

module.exports = {
  timezone,
  clientId: real(process.env.AZURE_CLIENT_ID).toLowerCase(),
  clientSecret: real(process.env.AZURE_CLIENT_SECRET),
  // Your own (bilan.com) tenant: used for GDAP import AND as the only tenant allowed to sign in.
  partnerTenantId: real(process.env.PARTNER_TENANT_ID).toLowerCase(), // token issuer/tenant checks are exact-match
  port,
  // 127.0.0.1 = this computer only. Use 0.0.0.0 to let other people reach the app (put HTTPS in front of it).
  host: process.env.HOST || (onAzure ? '0.0.0.0' : '127.0.0.1'),
  // The address people type in the browser. Its /auth/callback must be a Web redirect URI on the app registration.
  baseUrl,
  trustProxy: process.env.TRUST_PROXY === 'true' || onAzure,
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionHours: int(process.env.SESSION_HOURS, 8),
  authDisabled: process.env.AUTH_DISABLED === 'true', // local development only; refused unless HOST=127.0.0.1
  sweepIntervalMinutes: int(process.env.SWEEP_INTERVAL_MINUTES, 15),
  dataDir: process.env.DATA_DIR || require('path').join(__dirname, '..', 'data'),
};
