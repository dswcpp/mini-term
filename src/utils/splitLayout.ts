import type { PaneState, RunProfile, SplitNode } from '../types';

const DEFAULT_SIZE_TOLERANCE = 0.5;

function areRunProfilesEquivalent(left?: RunProfile, right?: RunProfile) {
  return (
    left?.savedCommand === right?.savedCommand
    && left?.lastRunAt === right?.lastRunAt
    && left?.lastExitCode === right?.lastExitCode
    && left?.usageScope === right?.usageScope
  );
}

function arePaneStatesEquivalent(left: PaneState, right: PaneState) {
  return (
    left.id === right.id
    && left.sessionId === right.sessionId
    && left.shellName === right.shellName
    && left.runCommand === right.runCommand
    && areRunProfilesEquivalent(left.runProfile, right.runProfile)
    && left.mode === right.mode
    && left.ptyId === right.ptyId
    && left.status === right.status
    && left.phase === right.phase
  );
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
