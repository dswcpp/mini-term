const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const contextMenu = read('src/utils/contextMenu.ts');
const paneGroup = read('src/components/PaneGroup.tsx');
const terminalInstance = read('src/components/TerminalInstance.tsx');
const styles = read('src/styles.css');

assert.match(
  contextMenu,
  /preview\?: TerminalLayoutPreset/,
  'context menu items must support terminal layout previews',
);
assert.match(
  contextMenu,
  /ctx-menu-preview--\$\{entry\.preview\}/,
  'context menu must render preview-specific CSS classes',
);

assert.match(
  terminalInstance,
  /contextMenuExtraItems\?: MenuEntry\[\]/,
  'TerminalInstance must expose an extension point for pane actions',
);
assert.match(
  terminalInstance,
  /menu\.push\(\{ separator: true \}, \.\.\.contextMenuExtraItems\)/,
  'pane actions must be appended to the native terminal context menu',
);

assert.match(
  paneGroup,
  /TERMINAL_LAYOUT_PRESETS\.map/,
  'PaneGroup must build grid menu items from shared preset definitions',
);
assert.doesNotMatch(
  paneGroup,
  /paneGroup\.twoColumnGrid|paneGroup\.twoRowGrid|paneGroup\.fourGrid/,
  'PaneGroup must not hard-code grid label keys outside preset definitions',
);

[
  '.pane-action-button',
  '.terminal-pane-frame.is-focused',
  '.layout-preview--quad',
  '.ctx-menu-description',
].forEach((selector) => {
  assert.ok(styles.includes(selector), `missing grid UI style: ${selector}`);
});
