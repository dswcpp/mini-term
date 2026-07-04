import { useAppStore } from '../store';
import { saveConfig } from './configApi';
import type { AppConfig, CcConnectConfig } from '../types';

/** 前端传给后端的默认可执行文件名；后端负责内置 sidecar 优先、PATH 兜底。 */
export const DEFAULT_CC_CONNECT_EXE = 'cc-connect';

export const DEFAULT_CC_CONNECT_CONFIG: CcConnectConfig = {
  exePath: '',
  configPath: '',
  autoStart: false,
  extraArgs: [],
  projectLinks: {},
};

export function normalizeCcConnectConfig(config: CcConnectConfig | undefined): CcConnectConfig {
  return {
    ...DEFAULT_CC_CONNECT_CONFIG,
    ...(config ?? {}),
    extraArgs: config?.extraArgs ?? DEFAULT_CC_CONNECT_CONFIG.extraArgs,
    projectLinks: config?.projectLinks ?? DEFAULT_CC_CONNECT_CONFIG.projectLinks,
  };
}

export function ccConnectExeOrDefault(exePath: string | undefined): string {
  return exePath?.trim() || DEFAULT_CC_CONNECT_EXE;
}

export function ccConnectConfigPathArg(configPath: string | undefined): string | undefined {
  const trimmed = configPath?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 更新 cc-connect 持久配置。
 *
 * 这是 cc-connect 功能入口的唯一保存路径：先乐观更新 store，save_config 失败时回滚，
 * 避免运行时 store 与磁盘 config.json 在静止状态下不一致。
 */
export async function saveCcConnectConfigPatch(
  patch: Partial<CcConnectConfig>,
): Promise<AppConfig> {
  const prevConfig = useAppStore.getState().config;
  const currentCc = normalizeCcConnectConfig(prevConfig.ccConnect);
  const newConfig: AppConfig = {
    ...prevConfig,
    ccConnect: { ...currentCc, ...patch },
  };

  useAppStore.getState().setConfig(newConfig);
  try {
    await saveConfig(newConfig);
    return newConfig;
  } catch (e) {
    useAppStore.getState().setConfig(prevConfig);
    throw e;
  }
}
