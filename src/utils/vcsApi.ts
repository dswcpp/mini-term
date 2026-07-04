import { invoke } from '@tauri-apps/api/core';
import type {
  ChangeFileStatus,
  GitDiffResult,
  GitFileStatus,
  VcsKind,
  VcsRepoInfo,
} from '../types';

export function discoverVcsRepos(projectPath: string): Promise<VcsRepoInfo[]> {
  return invoke<VcsRepoInfo[]>('discover_vcs_repos', { projectPath });
}

export function getVcsStatus(projectPath: string): Promise<GitFileStatus[]> {
  return invoke<GitFileStatus[]>('get_vcs_status', { projectPath });
}

export function getVcsChangesStatus(
  repoPath: string,
  vcsKind: VcsKind,
): Promise<ChangeFileStatus[]> {
  return invoke<ChangeFileStatus[]>('get_vcs_changes_status', { repoPath, vcsKind });
}

export function getVcsDiff(args: {
  projectPath: string;
  filePath: string;
  staged?: boolean;
  vcsKind?: VcsKind;
}): Promise<GitDiffResult> {
  return invoke<GitDiffResult>('get_vcs_diff', args);
}

export function vcsStage(
  repoPath: string,
  vcsKind: VcsKind,
  files: string[],
): Promise<void> {
  return invoke('vcs_stage', { repoPath, vcsKind, files });
}

export function gitUnstage(repoPath: string, files: string[]): Promise<void> {
  return invoke('git_unstage', { repoPath, files });
}

export function vcsStageAll(
  repoPath: string,
  vcsKind: VcsKind,
  includeUntracked = true,
): Promise<void> {
  return invoke('vcs_stage_all', { repoPath, vcsKind, includeUntracked });
}

export function gitUnstageAll(repoPath: string): Promise<void> {
  return invoke('git_unstage_all', { repoPath });
}

export function vcsCommit(
  repoPath: string,
  vcsKind: VcsKind,
  message: string,
): Promise<string> {
  return invoke<string>('vcs_commit', { repoPath, vcsKind, message });
}

export function vcsUpdate(repoPath: string, vcsKind: VcsKind): Promise<string> {
  return invoke<string>('vcs_update', { repoPath, vcsKind });
}

export function vcsDiscardFile(
  repoPath: string,
  vcsKind: VcsKind,
  files: string[],
): Promise<void> {
  return invoke('vcs_discard_file', { repoPath, vcsKind, files });
}
