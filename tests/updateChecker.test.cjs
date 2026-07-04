const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  checkForUpdate,
  compareVersions,
  extractReleaseTagFromUrl,
} = require('../.tmp-tests/utils/updateChecker.js');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'utils', 'updateChecker.ts'), 'utf8');

assert.match(
  source,
  /const GITHUB_REPO = 'dswcpp\/mini-term';/,
  'update checks must target the dswcpp fork',
);
assert.doesNotMatch(
  source,
  /dreamlonglll\/mini-term|github\.com\/dreamlonglll/,
  'update checks must not fall back to the old repository',
);
assert.ok(
  source.includes('/releases/latest'),
  'update checks need the GitHub latest-release redirect fallback',
);

assert.equal(compareVersions('v0.6.6', '0.6.5'), 1);
assert.equal(compareVersions('v0.6.5', '0.6.5'), 0);
assert.equal(compareVersions('v0.6.4', '0.6.5'), -1);

assert.equal(
  extractReleaseTagFromUrl('https://github.com/dswcpp/mini-term/releases/tag/v0.7.0'),
  'v0.7.0',
);
assert.equal(
  extractReleaseTagFromUrl('https://github.com/dswcpp/mini-term/releases/tag/release%2Fcandidate'),
  'release/candidate',
);
assert.equal(extractReleaseTagFromUrl('https://github.com/dswcpp/mini-term/releases/latest'), null);
assert.equal(extractReleaseTagFromUrl('not a url'), null);

(async () => {
  const apiCalls = [];
  global.fetch = async (url, options) => {
    apiCalls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          tag_name: 'v9.9.9',
          html_url: 'https://github.com/dswcpp/mini-term/releases/tag/v9.9.9',
          published_at: '2026-01-02T03:04:05Z',
        };
      },
    };
  };

  assert.deepEqual(await checkForUpdate('0.1.0'), {
    version: 'v9.9.9',
    url: 'https://github.com/dswcpp/mini-term/releases/tag/v9.9.9',
    publishedAt: '2026-01-02T03:04:05Z',
  });
  assert.equal(apiCalls.length, 1);
  assert.match(apiCalls[0].url, /api\.github\.com\/repos\/dswcpp\/mini-term\/releases\/latest/);

  const fallbackCalls = [];
  global.fetch = async (url, options) => {
    fallbackCalls.push({ url: String(url), options });
    if (String(url).includes('api.github.com')) {
      return { ok: false, status: 403 };
    }
    return {
      ok: true,
      status: 200,
      url: 'https://github.com/dswcpp/mini-term/releases/tag/v10.0.0',
    };
  };

  assert.deepEqual(await checkForUpdate('0.1.0'), {
    version: 'v10.0.0',
    url: 'https://github.com/dswcpp/mini-term/releases/tag/v10.0.0',
    publishedAt: '',
  });
  assert.equal(fallbackCalls.length, 2);
  assert.match(fallbackCalls[0].url, /api\.github\.com\/repos\/dswcpp\/mini-term\/releases\/latest/);
  assert.equal(fallbackCalls[1].url, 'https://github.com/dswcpp/mini-term/releases/latest');
  assert.equal(fallbackCalls[1].options.redirect, 'follow');

  global.fetch = async (url) => {
    if (String(url).includes('api.github.com')) {
      return { ok: false, status: 403 };
    }
    return {
      ok: true,
      status: 200,
      url: 'https://github.com/dswcpp/mini-term/releases',
    };
  };

  await assert.rejects(
    () => checkForUpdate('0.1.0'),
    /暂无发布版本|No releases published/,
  );

  delete global.fetch;
})().catch((error) => {
  delete global.fetch;
  throw error;
});
