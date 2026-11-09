require('dotenv').config();

module.exports = {
  clientId: process.env.AZURE_CLIENT_ID || '',
  clientSecret: process.env.AZURE_CLIENT_SECRET || '',
  partnerTenantId: process.env.PARTNER_TENANT_ID || '',
  port: parseInt(process.env.PORT || '3000', 10),
  sweepIntervalMinutes: parseInt(process.env.SWEEP_INTERVAL_MINUTES || '15', 10),
  dataDir: process.env.DATA_DIR || require('path').join(__dirname, '..', 'data'),
};
