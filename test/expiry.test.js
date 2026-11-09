const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../lib/store');
const { sweep, isExpired } = require('../lib/expiry');

const T = '11111111-1111-1111-1111-111111111111';
const mk = (userId, extra) => ({ tenantId: T, userId, upn: userId + '@x.com', permanent: false, ...extra });

function freshStore() {
  return createStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caex-')), 'db.json'));
}

test('isExpired: active through the end of the expiry date', () => {
  assert.equal(isExpired({ permanent: false, expiresOn: '2026-11-09' }, '2026-11-09'), false);
  assert.equal(isExpired({ permanent: false, expiresOn: '2026-11-09' }, '2026-11-10'), true);
  assert.equal(isExpired({ permanent: true, expiresOn: null }, '2099-01-01'), false);
});

test('sweep removes expired, keeps permanent and future', async () => {
  const store = freshStore();
  store.upsertExclusion(mk('old', { expiresOn: '2026-01-01' }));
  store.upsertExclusion(mk('future', { expiresOn: '2026-12-31' }));
  store.upsertExclusion(mk('perm', { permanent: true, expiresOn: null }));
  const removed = [];
  const r = await sweep({ store, today: '2026-11-09', removeMember: async (t, u) => removed.push(u) });
  assert.deepEqual(removed, ['old']);
  assert.equal(r.removed.length, 1);
  assert.deepEqual(store.allExclusions().map((x) => x.userId).sort(), ['future', 'perm']);
});

test('sweep keeps the record and notes the error when removal fails', async () => {
  const store = freshStore();
  store.upsertExclusion(mk('old', { expiresOn: '2026-01-01' }));
  const r = await sweep({ store, today: '2026-11-09', removeMember: async () => { throw new Error('boom'); } });
  assert.equal(r.failed.length, 1);
  assert.equal(store.findExclusion(T, 'old').lastError, 'boom');
});

const { isValidDate, localDate } = require('../lib/expiry');

test('isValidDate rejects impossible dates', () => {
  assert.equal(isValidDate('2026-11-09'), true);
  assert.equal(isValidDate('2028-02-29'), true); // leap year
  assert.equal(isValidDate('2026-02-31'), false);
  assert.equal(isValidDate('2026-13-01'), false);
  assert.equal(isValidDate('2026-2-3'), false);
  assert.equal(isValidDate(undefined), false);
});

test('localDate uses the given time zone, not the server clock zone', () => {
  const t = new Date('2026-11-10T02:30:00Z'); // 9:30pm Nov 9 in New York, already Nov 10 in UTC
  assert.equal(localDate(t, 'America/New_York'), '2026-11-09');
  assert.equal(localDate(t, 'UTC'), '2026-11-10');
});

test('sweep passes the record so removal targets the policy it was added to', async () => {
  const store = freshStore();
  store.upsertExclusion(mk('old', { expiresOn: '2026-01-01', policyId: 'policy-A' }));
  let seen;
  await sweep({ store, today: '2026-11-09', removeMember: async (t, u, ex) => { seen = ex.policyId; } });
  assert.equal(seen, 'policy-A');
});
