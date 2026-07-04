const assert = require('node:assert/strict');

const { restoreSavedProjectLayout } = require('../.tmp-tests/utils/layoutRestore.js');

const config = {
  availableShells: [
    { name: 'nushell', command: 'nu' },
    { name: 'cmd', command: 'cmd' },
  ],
  defaultShell: 'cmd',
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
        panes: [{ shellName: 'nushell' }],
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
assert.equal(restored.tabs.length, 2);
assert.equal(restored.activeTabId, restored.tabs[1].id);

const firstPane = restored.tabs[0].splitLayout.panes[0];
assert.equal(firstPane.shellName, 'nushell');
assert.equal(Object.hasOwn(firstPane, 'ptyId'), false);
assert.equal(firstPane.status, 'idle');

const split = restored.tabs[1].splitLayout;
assert.equal(split.type, 'split');
assert.deepEqual(split.sizes, [40, 60]);
assert.equal(split.children[0].panes[0].shellName, 'cmd');
assert.equal(Object.hasOwn(split.children[0].panes[0], 'ptyId'), false);
assert.equal(split.children[1].panes.length, 2);
