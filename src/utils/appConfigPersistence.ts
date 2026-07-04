import { useAppStore } from '../store';
import { saveConfig } from './configApi';
import type { AppConfig } from '../types';

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function saveConfigOptimistic(nextConfig: AppConfig): Promise<AppConfig> {
  const prevConfig = useAppStore.getState().config;
  useAppStore.getState().setConfig(nextConfig);
  try {
    await saveConfig(nextConfig);
    return nextConfig;
  } catch (error) {
    useAppStore.getState().setConfig(prevConfig);
    throw error;
  }
}

export function saveConfigPatch(
  updater: (config: AppConfig) => AppConfig,
): Promise<AppConfig> {
  return saveConfigOptimistic(updater(useAppStore.getState().config));
}
