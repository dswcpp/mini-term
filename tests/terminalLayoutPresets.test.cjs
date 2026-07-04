const assert = require('node:assert/strict');

const {
  TERMINAL_LAYOUT_PRESETS,
  buildTerminalLayoutPreset,
  collectPanesFromLayout,
  getTerminalLayoutPresetDefinition,
  getTerminalLayoutPresetPaneCount,
} = require('../.tmp-tests/utils/terminalLayoutPresets.js');

function pane(id) {
  return {
    id,
    shellName: 'PowerShell',
    status: 'idle',
    ptyId: Number(id.replace('p', '')),
  };
}

const panes = [pane('p1'), pane('p2'), pane('p3'), pane('p4'), pane('p5')];

assert.deepEqual(
  TERMINAL_LAYOUT_PRESETS.map((item) => item.preset),
  ['two-columns', 'two-rows', 'quad'],
);
assert.deepEqual(getTerminalLayoutPresetDefinition('quad'), {
  preset: 'quad',
  requiredPaneCount: 4,
  icon: '▦',
  labelKey: 'paneGroup.fourGrid',
  preview: 'quad',
});
assert.equal(getTerminalLayoutPresetPaneCount('two-columns'), 2);
assert.equal(getTerminalLayoutPresetPaneCount('two-rows'), 2);
assert.equal(getTerminalLayoutPresetPaneCount('quad'), 4);

const twoColumns = buildTerminalLayoutPreset('two-columns', panes.slice(0, 2), 'p1');
assert.equal(twoColumns.type, 'split');
assert.equal(twoColumns.direction, 'horizontal');
assert.deepEqual(twoColumns.sizes, [50, 50]);
assert.equal(twoColumns.children[0].type, 'leaf');
assert.equal(twoColumns.children[0].activePaneId, 'p1');
assert.equal(twoColumns.children[1].type, 'leaf');
assert.equal(twoColumns.children[1].activePaneId, 'p2');

const twoRows = buildTerminalLayoutPreset('two-rows', panes.slice(0, 2), 'p2');
assert.equal(twoRows.type, 'split');
assert.equal(twoRows.direction, 'vertical');
assert.deepEqual(collectPanesFromLayout(twoRows).map((item) => item.id), ['p2', 'p1']);

const quad = buildTerminalLayoutPreset('quad', panes.slice(0, 4), 'p3');
assert.equal(quad.type, 'split');
assert.equal(quad.direction, 'vertical');
assert.equal(quad.children.length, 2);
assert.equal(quad.children[0].direction, 'horizontal');
assert.equal(quad.children[1].direction, 'horizontal');
assert.deepEqual(collectPanesFromLayout(quad).map((item) => item.id), ['p3', 'p1', 'p2', 'p4']);

const quadWithExtra = buildTerminalLayoutPreset('quad', panes, 'p1');
assert.deepEqual(
  collectPanesFromLayout(quadWithExtra).map((item) => item.id).sort(),
  ['p1', 'p2', 'p3', 'p4', 'p5'],
);
assert.deepEqual(
  quadWithExtra.children[0].children[0].panes.map((item) => item.id),
  ['p1', 'p5'],
);

assert.throws(
  () => buildTerminalLayoutPreset('quad', panes.slice(0, 3), 'p1'),
  /requires at least 4 panes/,
);
