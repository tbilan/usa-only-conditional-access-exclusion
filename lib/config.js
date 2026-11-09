require('dotenv').config();

// Blank out the unedited placeholder values copied from .env.example.
const real = (v) => (v && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v) && v !== 'your-client-secret-value' ? v : '');

const port = parseInt(process.env.PORT || '3000', 10);

module.exports = {
  clientId: real(process.env.AZURE_CLIENT_ID),
  clientSecret: real(process.env.AZURE_CLIENT_SECRET),
  // Your own (bilan.com) tenant: used for GDAP import AND as the only tenant allowed to sign in.
  partnerTenantId: real(process.env.PARTNER_TENANT_ID),
  port,
  // 127.0.0.1 = this computer only. Use 0.0.0.0 to let other people reach the app (put HTTPS in front of it).
  host: process.env.HOST || '127.0.0.1',
  // The address people type in the browser. Its /auth/callback must be a Web redirect URI on the app registration.
  baseUrl: (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  trustProxy: process.env.TRUST_PROXY === 'true',
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionHours: parseInt(process.env.SESSION_HOURS || '8', 10),
  authDisabled: process.env.AUTH_DISABLED === 'true', // local development only; refused unless HOST=127.0.0.1
  sweepIntervalMinutes: parseInt(process.env.SWEEP_INTERVAL_MINUTES || '15', 10),
  dataDir: process.env.DATA_DIR || require('path').join(__dirname, '..', 'data'),
};
