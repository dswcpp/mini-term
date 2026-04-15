export function GitChanges({ projectPath, repoPath, onCommitSuccess: _onCommitSuccess }: {
  projectPath: string;
  repoPath: string;
  onCommitSuccess: () => void;
}) {
  return (
    <div className="h-full flex items-center justify-center text-[var(--text-muted)] text-sm">
      Changes — {repoPath || projectPath}
    </div>
  );
}
