import { t } from "../i18n";

const GITHUB_REPO = 'dswcpp/mini-term';
const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;
const GITHUB_LATEST_RELEASE_URL = `${GITHUB_RELEASES_URL}/latest`;
const GITHUB_API_LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

export interface ReleaseInfo {
  version: string;
  url: string;
  publishedAt: string;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function extractReleaseTagFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const releaseIndex = parts.findIndex((part, index) => (
      part === 'releases' && parts[index + 1] === 'tag'
    ));
    const tag = releaseIndex >= 0 ? parts[releaseIndex + 2] : undefined;
    return tag ? decodeURIComponent(tag) : null;
  } catch {
    return null;
  }
}

class UpdateCheckerError extends Error {
  constructor(
    message: string,
    readonly kind: 'no-release' | 'request-failed',
  ) {
    super(message);
  }
}

function noReleaseError(): UpdateCheckerError {
  return new UpdateCheckerError(t("updateChecker.noRelease"), 'no-release');
}

function githubRequestError(status: number): Error {
  return status === 404
    ? noReleaseError()
    : new UpdateCheckerError(t("updateChecker.requestFailed", { status }), 'request-failed');
}

function isNoReleaseError(error: unknown): boolean {
  return error instanceof UpdateCheckerError && error.kind === 'no-release';
}

async function fetchLatestReleaseFromApi(): Promise<ReleaseInfo> {
  const resp = await fetch(GITHUB_API_LATEST_RELEASE_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!resp.ok) throw githubRequestError(resp.status);
  const data = await resp.json();
  const version = String(data.tag_name ?? '').trim();
  if (!version) throw noReleaseError();
  return {
    version,
    url: String(data.html_url ?? GITHUB_RELEASES_URL),
    publishedAt: String(data.published_at ?? ''),
  };
}

async function fetchLatestReleaseFromRedirect(): Promise<ReleaseInfo> {
  const resp = await fetch(GITHUB_LATEST_RELEASE_URL, { redirect: 'follow' });
  if (!resp.ok) throw githubRequestError(resp.status);
  const tag = extractReleaseTagFromUrl(resp.url);
  if (!tag) throw noReleaseError();
  return {
    version: tag,
    url: resp.url || `${GITHUB_RELEASES_URL}/tag/${encodeURIComponent(tag)}`,
    publishedAt: '',
  };
}

export async function checkForUpdate(currentVersion: string): Promise<ReleaseInfo | null> {
  let release: ReleaseInfo;
  try {
    release = await fetchLatestReleaseFromApi();
  } catch (apiError) {
    try {
      release = await fetchLatestReleaseFromRedirect();
    } catch (fallbackError) {
      if (isNoReleaseError(fallbackError)) throw fallbackError;
      throw apiError;
    }
  }

  return compareVersions(release.version, currentVersion) > 0 ? release : null;
}
