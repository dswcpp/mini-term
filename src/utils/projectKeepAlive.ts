export function includeActiveProject(mountedProjectIds: string[], activeProjectId: string | null): string[] {
  if (!activeProjectId || mountedProjectIds.includes(activeProjectId)) {
    return mountedProjectIds;
  }
  return [...mountedProjectIds, activeProjectId];
}
