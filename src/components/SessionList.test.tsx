import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store';
import { SessionList } from './SessionList';

const listExternalSessions = vi.fn();
const getExternalSessionMessages = vi.fn();
const deleteExternalSession = vi.fn();
const showContextMenu = vi.fn();

vi.mock('../runtime/externalSessionApi', () => ({
  listExternalSessions: (...args: unknown[]) => listExternalSessions(...args),
  getExternalSessionMessages: (...args: unknown[]) => getExternalSessionMessages(...args),
  deleteExternalSession: (...args: unknown[]) => deleteExternalSession(...args),
}));

vi.mock('../utils/contextMenu', () => ({
  showContextMenu: (...args: unknown[]) => showContextMenu(...args),
}));

describe('SessionList', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    useAppStore.setState((state) => ({
      ...state,
      activeWorkspaceId: 'workspace-1',
      config: {
        ...state.config,
        workspaces: [
          {
            id: 'workspace-1',
            name: 'mini-term',
            roots: [
              {
                id: 'root-1',
                name: 'mini-term',
                path: 'D:/code/JavaScript/mini-term',
                role: 'primary',
              },
            ],
            pinned: false,
            createdAt: 1,
            lastOpenedAt: 1,
          },
        ],
      },
    }));

    listExternalSessions.mockResolvedValue([
      {
        providerId: 'claude',
        sessionId: 'claude-session-1',
        title: 'Claude Review Session',
        timestamp: '2026-04-06T12:00:00.000Z',
        summary: 'Reviewing Mini-Term MCP interop changes.',
        projectPath: 'D:/code/JavaScript/mini-term',
        sourcePath: 'C:/Users/test/.claude/projects/mini-term/session-1.jsonl',
        resumeCommand: 'claude --resume claude-session-1',
      },
    ]);
    getExternalSessionMessages.mockResolvedValue([
      {
        role: 'user',
        content: 'Please review the MCP interop implementation.',
        timestamp: '2026-04-06T12:00:01.000Z',
      },
      {
        role: 'assistant',
        content: 'I checked the imported server catalog and found two issues.',
        timestamp: '2026-04-06T12:00:05.000Z',
      },
    ]);
    deleteExternalSession.mockResolvedValue({
      providerId: 'claude',
      sessionId: 'claude-session-1',
      sourcePath: 'C:/Users/test/.claude/projects/mini-term/session-1.jsonl',
      deleted: true,
    });
  });

  it('loads workspace-scoped external sessions and previews message history', async () => {
    render(<SessionList />);

    expect(await screen.findByText('Claude Review Session')).not.toBeNull();
    expect(listExternalSessions).toHaveBeenCalledWith(['D:/code/JavaScript/mini-term']);

    fireEvent.click(screen.getByRole('button', { name: /Claude Review Session/i }));

    await waitFor(() => {
      expect(getExternalSessionMessages).toHaveBeenCalledWith(
        'claude',
        'C:/Users/test/.claude/projects/mini-term/session-1.jsonl',
      );
    });

    expect(await screen.findByText('Please review the MCP interop implementation.')).not.toBeNull();
    expect(screen.getByText('I checked the imported server catalog and found two issues.')).not.toBeNull();
    expect(screen.getByText('Copy Resume')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Claude Review Session/i }));
    fireEvent.click(screen.getByRole('button', { name: /Claude Review Session/i }));

    await waitFor(() => {
      expect(getExternalSessionMessages).toHaveBeenCalledTimes(1);
    });
  });
});
