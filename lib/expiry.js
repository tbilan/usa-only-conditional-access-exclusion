const cfg = require('./config');

/** Calendar date (YYYY-MM-DD) in the app's configured time zone. */
function localDate(d = new Date(), timeZone = cfg.timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** True only for real calendar dates in YYYY-MM-DD form (rejects 2026-02-31). */
function isValidDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * An exclusion with expiresOn = D stays active through the end of day D (app time zone),
 * and is removed by the first sweep on D+1.
 */
function isExpired(ex, today = localDate()) {
  return !ex.permanent && !!ex.expiresOn && ex.expiresOn < today;
}

/** Remove every expired exclusion from its tenant's policy, then drop the record. */
async function sweep({ store, removeMember, today = localDate() }) {
  const result = { removed: [], failed: [] };
  for (const ex of [...store.allExclusions()]) {
    if (!isExpired(ex, today)) continue;
    try {
      await removeMember(ex.tenantId, ex.userId, ex);
      store.deleteExclusion(ex.tenantId, ex.userId);
      store.audit(ex.tenantId, 'exclusion-expired', `${ex.upn} (expired ${ex.expiresOn})`);
      result.removed.push(ex);
    } catch (e) {
      store.upsertExclusion({ tenantId: ex.tenantId, userId: ex.userId, lastError: e.message });
      result.failed.push({ ...ex, error: e.message });
    }
  }
  return result;
}

module.exports = { localDate, isValidDate, isExpired, sweep };
