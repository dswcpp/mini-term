import { invoke } from '@tauri-apps/api/core';
import type {
  BatchImportResult,
  CcConnectStatus,
  CcProject,
  ImportProjectRequest,
  ImportProjectResult,
  UnlinkProjectResult,
} from '../types';
import { ccConnectConfigPathArg, ccConnectExeOrDefault } from './ccConnectConfig';

export function probeCcConnect(configPath?: string): Promise<CcConnectStatus> {
  return invoke<CcConnectStatus>('cc_connect_probe', {
    configPath: ccConnectConfigPathArg(configPath),
  });
}

export function startCcConnect(args: {
  exePath?: string;
  configPath?: string;
  extraArgs?: string[];
}): Promise<number> {
  return invoke<number>('cc_connect_start', {
    exePath: ccConnectExeOrDefault(args.exePath),
    configPath: ccConnectConfigPathArg(args.configPath),
    extraArgs: args.extraArgs ?? [],
  });
}

export function stopCcConnect(): Promise<void> {
  return invoke('cc_connect_stop');
}

export function restartCcConnect(args: {
  exePath?: string;
  configPath?: string;
  extraArgs?: string[];
}): Promise<void> {
  return invoke('cc_connect_restart', {
    exePath: ccConnectExeOrDefault(args.exePath),
    configPath: ccConnectConfigPathArg(args.configPath),
    extraArgs: args.extraArgs ?? [],
  });
}

export function resolveCcConnectConfigPath(configPath?: string): Promise<string> {
  return invoke<string>('cc_connect_config_path', {
    configPath: ccConnectConfigPathArg(configPath),
  });
}

export function readCcConnectToken(configPath?: string): Promise<string> {
  return invoke<string>('cc_connect_read_token', {
    configPath: ccConnectConfigPathArg(configPath),
  });
}

export function listCcConnectProjects(configPath?: string): Promise<CcProject[]> {
  return invoke<CcProject[]>('cc_connect_list_projects', {
    configPath: ccConnectConfigPathArg(configPath),
  });
}

export function importCcConnectProject(
  req: ImportProjectRequest,
  configPath?: string,
): Promise<ImportProjectResult> {
  return invoke<ImportProjectResult>('cc_connect_import_project', {
    req,
    configPath: ccConnectConfigPathArg(configPath),
  });
}

export function importCcConnectProjects(
  reqs: ImportProjectRequest[],
  configPath?: string,
): Promise<BatchImportResult> {
  return invoke<BatchImportResult>('cc_connect_import_projects', {
    reqs,
    configPath: ccConnectConfigPathArg(configPath),
  });
}

export function unlinkCcConnectProject(
  name: string,
  configPath?: string,
): Promise<UnlinkProjectResult> {
  return invoke<UnlinkProjectResult>('cc_connect_unlink_project', {
    name,
    configPath: ccConnectConfigPathArg(configPath),
  });
}
