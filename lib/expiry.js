/** Local calendar date as YYYY-MM-DD. */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * An exclusion with expiresOn = D stays active through the end of day D (server local time),
 * and is removed by the first sweep on D+1.
 */
function isExpired(ex, today = localDate()) {
  return !ex.permanent && !!ex.expiresOn && ex.expiresOn < today;
}

/** Remove every expired exclusion from its tenant's group, then drop the record. */
async function sweep({ store, removeMember, today = localDate() }) {
  const result = { removed: [], failed: [] };
  for (const ex of [...store.allExclusions()]) {
    if (!isExpired(ex, today)) continue;
    try {
      await removeMember(ex.tenantId, ex.userId);
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

module.exports = { localDate, isExpired, sweep };
