const fs = require('fs');
const path = require('path');

/** Tiny JSON-file store (tenants, tracked exclusions, audit log). */
function createStore(file) {
  const empty = () => ({ tenants: [], exclusions: [], audit: [] });
  let db;
  try {
    db = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    db = empty();
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file);
  }

  const same = (a, b) => a.toLowerCase() === b.toLowerCase();

  return {
    tenants: () => db.tenants,
    getTenant: (id) => db.tenants.find((t) => same(t.tenantId, id)),
    addTenant(tenantId, name) {
      if (db.tenants.some((t) => same(t.tenantId, tenantId))) return false;
      db.tenants.push({ tenantId: tenantId.toLowerCase(), name, addedAt: new Date().toISOString() });
      db.tenants.sort((a, b) => a.name.localeCompare(b.name));
      save();
      return true;
    },
    setTenantPolicy(tenantId, policyId, policyName) {
      const t = db.tenants.find((x) => same(x.tenantId, tenantId));
      if (!t) return;
      t.policyId = policyId;
      t.policyName = policyName;
      save();
    },
    removeTenant(tenantId) {
      db.tenants = db.tenants.filter((t) => !same(t.tenantId, tenantId));
      db.exclusions = db.exclusions.filter((x) => !same(x.tenantId, tenantId));
      db.audit = db.audit.filter((a) => !same(a.tenantId, tenantId));
      save();
    },
    allExclusions: () => db.exclusions,
    exclusions: (tenantId) => db.exclusions.filter((x) => same(x.tenantId, tenantId)),
    findExclusion: (tenantId, userId) =>
      db.exclusions.find((x) => same(x.tenantId, tenantId) && same(x.userId, userId)),
    upsertExclusion(rec) {
      const i = db.exclusions.findIndex((x) => same(x.tenantId, rec.tenantId) && same(x.userId, rec.userId));
      if (i >= 0) db.exclusions[i] = { ...db.exclusions[i], ...rec };
      else db.exclusions.push(rec);
      save();
    },
    deleteExclusion(tenantId, userId) {
      db.exclusions = db.exclusions.filter((x) => !(same(x.tenantId, tenantId) && same(x.userId, userId)));
      save();
    },
    audit(tenantId, action, detail) {
      db.audit.push({ at: new Date().toISOString(), tenantId, action, detail });
      if (db.audit.length > 2000) db.audit = db.audit.slice(-2000);
      save();
    },
    auditLog: (tenantId, limit = 50) =>
      db.audit.filter((a) => a.tenantId === tenantId).slice(-limit).reverse(),
  };
}

module.exports = { createStore };
