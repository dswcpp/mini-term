import { CommitDiffModal } from './CommitDiffModal';
import { DiffModal } from './DiffModal';
import type { CommitDiffTab, WorktreeDiffTab } from '../types';

interface WorktreeDiffTabHostProps {
  tab: WorktreeDiffTab;
  isActive: boolean;
  onClose: () => void;
}

export function WorktreeDiffTabHost({ tab, isActive, onClose }: WorktreeDiffTabHostProps) {
  return (
    <DiffModal
      variant="tab"
      active={isActive}
      onClose={onClose}
      projectPath={tab.projectPath}
      status={tab.status}
    />
  );
}

interface CommitDiffTabHostProps {
  tab: CommitDiffTab;
  isActive: boolean;
  onClose: () => void;
}

export function CommitDiffTabHost({ tab, isActive, onClose }: CommitDiffTabHostProps) {
  return (
    <CommitDiffModal
      variant="tab"
      active={isActive}
      onClose={onClose}
      repoPath={tab.repoPath}
      commitHash={tab.commitHash}
      commitMessage={tab.commitMessage}
      files={tab.files}
    />
  );
}
