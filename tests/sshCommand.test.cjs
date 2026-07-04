const assert = require('node:assert/strict');

const {
  buildSshCommand,
  validateSshConnectionTarget,
} = require('../.tmp-tests/utils/sshCommand.js');

const base = {
  id: '1',
  name: 'prod',
  host: 'example.com',
  port: 22,
  user: 'deploy',
};

assert.equal(buildSshCommand(base), 'ssh deploy@example.com');

assert.equal(
  buildSshCommand({ ...base, port: 2222 }),
  'ssh -p 2222 deploy@example.com',
);

assert.equal(
  buildSshCommand(base, 'C:\\Users\\me\\.ssh\\prod key'),
  'ssh -i "C:/Users/me/.ssh/prod key" -o IdentitiesOnly=yes deploy@example.com',
);

assert.deepEqual(
  validateSshConnectionTarget({ user: 'deploy;rm', host: 'example.com', port: 22 }),
  { ok: false, reason: 'invalid-user' },
);

assert.deepEqual(
  validateSshConnectionTarget({ user: 'deploy', host: 'example.com && whoami', port: 22 }),
  { ok: false, reason: 'invalid-host' },
);

assert.deepEqual(
  validateSshConnectionTarget({ user: 'deploy', host: 'example.com', port: 65536 }),
  { ok: false, reason: 'invalid-port' },
);

assert.throws(
  () => buildSshCommand({ ...base, host: 'example.com;whoami' }),
  /invalid-host/,
);
