import { useCallback, useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';

const GITHUB_REPO = 'dreamlonglll/mini-term';

interface ReleaseInfo {
  version: string;
  url: string;
  publishedAt: string;
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);

  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }

  return 0;
}

export function AboutSettings() {
  const [currentVersion, setCurrentVersion] = useState('');
  const [latest, setLatest] = useState<ReleaseInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void getVersion().then(setCurrentVersion);
  }, []);

  const checkUpdate = useCallback(async () => {
    setChecking(true);
    setError('');
    setLatest(null);

    try {
      const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
      if (!response.ok) {
        throw new Error(response.status === 404 ? '暂时还没有可用版本。' : `请求失败（${response.status}）`);
      }

      const data = await response.json();
      setLatest({
        version: data.tag_name,
        url: data.html_url,
        publishedAt: data.published_at,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '检查更新失败，请稍后重试。');
    } finally {
      setChecking(false);
    }
  }, []);

  const hasUpdate = latest && compareVersions(latest.version, currentVersion) > 0;

  return (
    <div className="space-y-6">
      <div className="mb-2 text-base uppercase tracking-[0.1em] text-[var(--text-muted)]">
        版本信息
      </div>

      <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-3">
        <span className="text-base text-[var(--text-secondary)]">当前版本</span>
        <span className="font-mono text-base text-[var(--accent)]">v{currentVersion}</span>
      </div>

      <button
        type="button"
        className="w-full rounded-[var(--radius-md)] border border-[var(--border-default)] py-2.5 text-base text-[var(--text-secondary)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
        onClick={checkUpdate}
        disabled={checking}
      >
        {checking ? '正在检查更新...' : '检查更新'}
      </button>

      {error && (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-error)]/30 bg-[var(--bg-base)] px-4 py-3 text-sm text-[var(--color-error)]">
          {error}
        </div>
      )}

      {latest && (
        <div
          className={`rounded-[var(--radius-md)] border bg-[var(--bg-base)] px-4 py-3 ${
            hasUpdate ? 'border-[var(--accent)]/50' : 'border-[var(--border-subtle)]'
          }`}
        >
          {hasUpdate ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-base text-[var(--text-primary)]">发现新版本</span>
                <span className="font-mono text-base text-[var(--accent)]">{latest.version}</span>
              </div>
              <div className="text-sm text-[var(--text-muted)]">
                发布时间：{new Date(latest.publishedAt).toLocaleDateString('zh-CN')}
              </div>
              <button
                type="button"
                className="w-full rounded-[var(--radius-sm)] bg-[var(--accent)] py-2 text-base font-medium text-[var(--bg-base)] transition-opacity hover:opacity-90"
                onClick={() => openUrl(latest.url)}
              >
                打开 GitHub 发布页
              </button>
            </div>
          ) : (
            <div className="text-base text-[var(--text-secondary)]">当前已经是最新版本。</div>
          )}
        </div>
      )}

      <div className="pt-2 text-sm text-[var(--text-muted)]">
        版本信息会从 GitHub 发布页拉取。
      </div>
    </div>
  );
}
