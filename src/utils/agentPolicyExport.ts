import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { AgentPolicyExportBundle } from '../types';

function slugifySegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function buildFolderName(bundle: AgentPolicyExportBundle) {
  const workspaceSegment = slugifySegment(bundle.workspaceName ?? 'global') || 'global';
  return `mini-term-policy-${bundle.clientType}-${workspaceSegment}`;
}

async function ensureUniqueDirectory(baseDirectory: string, folderName: string) {
  const candidates = [folderName, `${folderName}-${Date.now()}`];

  for (const candidate of candidates) {
    const fullPath = `${baseDirectory}/${candidate}`;
    try {
      await invoke('create_directory', { path: fullPath });
      return fullPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes('exist')) {
        throw error;
      }
    }
  }

  throw new Error('Failed to create export directory.');
}

async function writeText(path: string, content: string) {
  await invoke('write_text_file', { path, content });
}

export async function exportAgentPolicyBundleFiles(bundle: AgentPolicyExportBundle) {
  const selectedDirectory = await open({
    directory: true,
    multiple: false,
    title: 'Export Mini-Term policy bundle',
  });

  if (!selectedDirectory || Array.isArray(selectedDirectory)) {
    return null;
  }

  const exportDirectory = await ensureUniqueDirectory(selectedDirectory, buildFolderName(bundle));
  const presetTemplates = {
    light: bundle.taskPresetTemplates.light,
    standard: bundle.taskPresetTemplates.standard,
    review: bundle.taskPresetTemplates.review,
  };
  const manifest = {
    clientType: bundle.clientType,
    workspaceId: bundle.workspaceId ?? null,
    workspaceName: bundle.workspaceName ?? null,
    profileId: bundle.profile.id,
    effectivePolicySummary: bundle.effectivePolicySummary,
    mcpLaunchStatus: bundle.mcpLaunch.status,
    exportedAt: new Date().toISOString(),
  };

  await Promise.all([
    writeText(`${exportDirectory}/platform-prompt.md`, bundle.platformPrompt),
    writeText(`${exportDirectory}/tool-policy-prompt.md`, bundle.toolPolicyPrompt),
    writeText(`${exportDirectory}/client-wrapper-prompt.md`, bundle.clientWrapperPrompt),
    writeText(`${exportDirectory}/workspace-override.md`, bundle.workspaceOverridePrompt),
    writeText(`${exportDirectory}/system-prompt.md`, bundle.systemPrompt),
    writeText(`${exportDirectory}/skill.md`, bundle.skillText),
    writeText(`${exportDirectory}/mcp-instructions.md`, bundle.mcpInstructions),
    writeText(`${exportDirectory}/mcp-launch.json`, JSON.stringify(bundle.mcpLaunch, null, 2)),
    writeText(`${exportDirectory}/mcp-config.json`, bundle.mcpConfigJson),
    writeText(`${exportDirectory}/task-presets.json`, JSON.stringify(presetTemplates, null, 2)),
    writeText(`${exportDirectory}/manifest.json`, JSON.stringify(manifest, null, 2)),
  ]);

  return exportDirectory;
}
