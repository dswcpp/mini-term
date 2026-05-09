import type { RunProfile, SplitNode, WorkspacePane } from '../types';

const DEFAULT_SIZE_TOLERANCE = 0.5;

function areRunProfilesEquivalent(left?: RunProfile, right?: RunProfile) {
  return (
    left?.savedCommand === right?.savedCommand
    && left?.lastRunAt === right?.lastRunAt
    && left?.lastExitCode === right?.lastExitCode
    && left?.usageScope === right?.usageScope
  );
}

function arePaneStatesEquivalent(left: WorkspacePane, right: WorkspacePane) {
  if (left.kind !== right.kind || left.id !== right.id || left.status !== right.status) {
    return false;
  }

  switch (left.kind) {
    case 'terminal':
      return (
        right.kind === 'terminal'
        && left.sessionId === right.sessionId
        && left.shellName === right.shellName
        && left.runCommand === right.runCommand
        && areRunProfilesEquivalent(left.runProfile, right.runProfile)
        && left.mode === right.mode
        && left.ptyId === right.ptyId
        && left.phase === right.phase
      );
    case 'file-viewer':
      return (
        right.kind === 'file-viewer'
        && left.filePath === right.filePath
        && left.mode === right.mode
        && JSON.stringify(left.navigationTarget ?? null) === JSON.stringify(right.navigationTarget ?? null)
      );
    case 'worktree-diff':
      return right.kind === 'worktree-diff' && JSON.stringify(left.gitStatus) === JSON.stringify(right.gitStatus) && left.projectPath === right.projectPath;
    case 'commit-diff':
      return (
        right.kind === 'commit-diff'
        && left.repoPath === right.repoPath
        && left.commitHash === right.commitHash
        && left.commitMessage === right.commitMessage
        && JSON.stringify(left.files) === JSON.stringify(right.files)
      );
    case 'file-history':
      return right.kind === 'file-history' && left.projectPath === right.projectPath && left.filePath === right.filePath;
    case 'agent-tasks':
      return (
        right.kind === 'agent-tasks'
        && JSON.stringify(left.filter) === JSON.stringify(right.filter)
        && left.selectedTaskId === right.selectedTaskId
      );
  }
}

export function areSplitSizesEquivalent(
  left: number[],
  right: number[],
  tolerance = DEFAULT_SIZE_TOLERANCE,
) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => Math.abs(value - right[index]) < tolerance);
}

export function areSplitNodesEquivalent(left: SplitNode, right: SplitNode): boolean {
  if (left.type !== right.type) {
    return false;
  }

  if (left.type === 'leaf' && right.type === 'leaf') {
    return arePaneStatesEquivalent(left.pane, right.pane);
  }

  if (left.type !== 'split' || right.type !== 'split') {
    return false;
  }

  if (
    left.direction !== right.direction
    || left.children.length !== right.children.length
    || !areSplitSizesEquivalent(left.sizes, right.sizes)
  ) {
    return false;
  }

  return left.children.every((child, index) => areSplitNodesEquivalent(child, right.children[index]));
}

export function getSplitNodeStructureKey(node: SplitNode): string {
  if (node.type === 'leaf') {
    return `leaf:${node.pane.id}`;
  }

  return `split:${node.direction}:${node.children.map(getSplitNodeStructureKey).join('|')}`;
}
