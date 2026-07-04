const assert = require('node:assert/strict');

const { getCurrentLineSnapshotFromBuffer } = require('../.tmp-tests/utils/terminalSnapshot.js');

class FakeLine {
  constructor(text, isWrapped = false) {
    this.text = text;
    this.isWrapped = isWrapped;
  }

  translateToString(trimRight, startColumn = 0, endColumn = this.text.length) {
    const value = this.text.slice(startColumn, endColumn);
    return trimRight ? value.trimEnd() : value;
  }
}

function fakeBuffer(lines) {
  return {
    getLine(index) {
      return lines[index];
    },
  };
}

(() => {
  const prompt = 'D:\\Git\\mini-term> ';
  const suggestion = 'claude';
  const beforeSuggestion = getCurrentLineSnapshotFromBuffer(
    fakeBuffer([new FakeLine(prompt + suggestion)]),
    0,
    prompt.length,
  );

  assert.equal(beforeSuggestion, 'D:\\Git\\mini-term>');

  const afterHistoryAccept = getCurrentLineSnapshotFromBuffer(
    fakeBuffer([new FakeLine(prompt + suggestion)]),
    0,
    prompt.length + suggestion.length,
  );

  assert.equal(afterHistoryAccept, 'D:\\Git\\mini-term> claude');

  const wrapped = getCurrentLineSnapshotFromBuffer(
    fakeBuffer([
      new FakeLine('D:\\Git\\very-long-path> cla', false),
      new FakeLine('ude --dangerously-skip-permissions ghost', true),
    ]),
    1,
    'ude --dangerously-skip-permissions'.length,
  );

  assert.equal(wrapped, 'D:\\Git\\very-long-path> claude --dangerously-skip-permissions');
})();
