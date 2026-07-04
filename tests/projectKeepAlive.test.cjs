const assert = require('node:assert/strict');

const { includeActiveProject } = require('../.tmp-tests/utils/projectKeepAlive.js');

assert.deepEqual(includeActiveProject([], null), []);
assert.deepEqual(includeActiveProject(['a'], 'a'), ['a']);
assert.deepEqual(includeActiveProject(['a'], 'b'), ['a', 'b']);
assert.deepEqual(includeActiveProject(['a', 'b'], 'a'), ['a', 'b']);
