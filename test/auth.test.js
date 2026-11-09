const test = require('node:test');
const assert = require('node:assert');
process.env.SESSION_SECRET = 'test-secret';
const { sign, verify } = require('../lib/auth');

test('a signed token verifies and carries its payload', () => {
  const t = sign({ upn: 'a@bilan.com' }, 60);
  assert.equal(verify(t).upn, 'a@bilan.com');
});

test('tampered, forged and expired tokens are rejected', () => {
  const t = sign({ upn: 'a@bilan.com' }, 60);
  const [body, mac] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ upn: 'evil@x.com', exp: 9999999999 })).toString('base64url');
  assert.equal(verify(`${forged}.${mac}`), null);
  assert.equal(verify(`${body}.AAAA`), null);
  assert.equal(verify('garbage'), null);
  assert.equal(verify(undefined), null);
  assert.equal(verify(sign({ upn: 'a@bilan.com' }, -5)), null);
});
