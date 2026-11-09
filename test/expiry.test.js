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
