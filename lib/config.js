require('dotenv').config();

// Blank out the unedited placeholder values copied from .env.example.
const real = (v) => (v && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v) && v !== 'your-client-secret-value' ? v : '');

module.exports = {
  clientId: real(process.env.AZURE_CLIENT_ID),
  clientSecret: real(process.env.AZURE_CLIENT_SECRET),
  partnerTenantId: real(process.env.PARTNER_TENANT_ID),
  port: parseInt(process.env.PORT || '3000', 10),
  sweepIntervalMinutes: parseInt(process.env.SWEEP_INTERVAL_MINUTES || '15', 10),
  dataDir: process.env.DATA_DIR || require('path').join(__dirname, '..', 'data'),
};
