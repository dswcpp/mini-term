import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../store';
import type { AppConfig } from '../../types';

export async function saveAppConfig(nextConfig: AppConfig) {
  useAppStore.getState().setConfig(nextConfig);
  await invoke('save_config', { config: useAppStore.getState().config });
}

export async function patchAppConfig(updater: (config: AppConfig) => AppConfig) {
  const currentConfig = useAppStore.getState().config;
  const nextConfig = updater(currentConfig);
  await saveAppConfig(nextConfig);
}
