import { useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { buildWorkspaceOverviewSnapshot } from '../utils/workspaceOverview';

const REFRESH_INTERVAL_MS = 60_000;

let refreshPromise: Promise<void> | null = null;

export async function refreshWorkspaceOverview(): Promise<void> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const store = useAppStore.getState();
    store.patchWorkspaceOverview({
      refreshStatus: 'loading',
      error: undefined,
    });

    try {
      const latest = useAppStore.getState();
      const snapshot = await buildWorkspaceOverviewSnapshot({
        config: latest.config,
        projectStates: latest.projectStates,
        notifications: latest.notifications,
        ccConnectStatus: latest.ccConnectStatus,
      });
      useAppStore.getState().setWorkspaceOverview(snapshot);
    } catch (e) {
      useAppStore.getState().patchWorkspaceOverview({
        refreshStatus: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();

  try {
    await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

export function useWorkspaceOverview(configLoaded: boolean) {
  const overviewVisible = useAppStore((s) => s.config.overviewVisible);
  const visibleRef = useRef(overviewVisible);

  useEffect(() => {
    if (!configLoaded) return;
    void refreshWorkspaceOverview();
    const timer = window.setInterval(() => {
      void refreshWorkspaceOverview();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [configLoaded]);

  useEffect(() => {
    if (!configLoaded) return;
    if (!visibleRef.current && overviewVisible) {
      void refreshWorkspaceOverview();
    }
    visibleRef.current = overviewVisible;
  }, [configLoaded, overviewVisible]);
}
