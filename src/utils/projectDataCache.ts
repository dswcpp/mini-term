import type { FileEntry, GitFileStatus, GitRepoInfo } from '../types';

interface FileTreeCache {
  rootEntries: FileEntry[];
  gitStatusMap: Map<string, GitFileStatus>;
}

interface GitHistoryCache {
  repos: GitRepoInfo[];
  selectedRepo: string;
}

const fileTreeCache = new Map<string, FileTreeCache>();
const gitHistoryCache = new Map<string, GitHistoryCache>();

export function getFileTreeCache(projectPath: string): FileTreeCache | undefined {
  return fileTreeCache.get(projectPath);
}

export function setFileTreeCache(projectPath: string, data: FileTreeCache): void {
  fileTreeCache.set(projectPath, data);
}

export function getGitHistoryCache(projectPath: string): GitHistoryCache | undefined {
  return gitHistoryCache.get(projectPath);
}

export function setGitHistoryCache(projectPath: string, data: GitHistoryCache): void {
  gitHistoryCache.set(projectPath, data);
}

export function clearProjectCache(projectPath: string): void {
  fileTreeCache.delete(projectPath);
  gitHistoryCache.delete(projectPath);
}
