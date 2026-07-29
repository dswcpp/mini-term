const assert = require('node:assert/strict');

const { restoreSavedProjectLayout } = require('../.tmp-tests/utils/layoutRestore.js');

const config = {
  availableShells: [
    { name: 'nushell', command: 'nu' },
    { name: 'cmd', command: 'cmd' },
  ],
  defaultShell: 'cmd',
  terminalEncoding: 'utf-8',
};

let id = 0;
const createId = () => `pane-${++id}`;

const savedLayout = {
  activeTabIndex: 1,
  tabs: [
    {
      customTitle: 'first',
      splitLayout: {
        type: 'leaf',
        panes: [{ shellName: 'nushell', customTitle: 'Build', terminalEncoding: 'gbk', cwd: 'D:/worktrees/build' }],
      },
    },
    {
      splitLayout: {
        type: 'split',
        direction: 'horizontal',
        sizes: [40, 60],
        children: [
          { type: 'leaf', panes: [{ shellName: 'missing-shell' }] },
          { type: 'leaf', panes: [{ shellName: 'nushell' }, { shellName: 'cmd' }] },
        ],
      },
    },
  ],
};

const restored = restoreSavedProjectLayout('project-1', savedLayout, config, createId);

assert.equal(restored.id, 'project-1');
assert.equal(restored.status, 'idle');

const split = restored.layout;
assert.equal(split.type, 'split');
assert.deepEqual(split.sizes, [40, 60]);

const fallbackPane = split.children[0].panes[0];
assert.equal(fallbackPane.shellName, 'cmd');
assert.equal(fallbackPane.terminalEncoding, 'utf-8');
assert.equal(Object.hasOwn(fallbackPane, 'ptyId'), false);

const firstPane = split.children[0].panes[1];
assert.equal(firstPane.shellName, 'nushell');
assert.equal(firstPane.customTitle, 'Build');
assert.equal(firstPane.cwd, 'D:/worktrees/build');
assert.equal(firstPane.terminalEncoding, 'gbk');
assert.equal(Object.hasOwn(firstPane, 'ptyId'), false);
assert.equal(firstPane.status, 'idle');
assert.equal(split.children[1].panes.length, 2);
