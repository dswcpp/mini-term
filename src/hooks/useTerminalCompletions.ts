import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store';
import type { FileContentResult, FileEntry, GitCompletionData } from '../types';
import {
  applyCompletionEdit,
  getTerminalInputState,
  subscribeTerminalInputState,
} from '../utils/terminalCache';
import { isSameCompletionEdit } from '../utils/terminalInputState';
import { buildCompletionResult, candidateToEdit } from '../utils/terminalCompletion/matcher';
import { createCompletionContext } from '../utils/terminalCompletion/parser';
import { joinPath, normalizePath } from '../utils/terminalCompletion/path';
import { collectCompletionCandidates } from '../utils/terminalCompletion/providers';
import { normalizeUsageScopeKey } from '../utils/terminalCompletion/usage';
import type { CompletionCandidate, CompletionEdit, CompletionResult } from '../utils/terminalCompletion/types';
import type { TerminalInputState } from '../utils/terminalInputState';

const DIRECTORY_CACHE_TTL = 5_000;
const PACKAGE_CACHE_TTL = 5_000;
const GIT_COMPLETION_CACHE_TTL = 5_000;
const MAX_VISIBLE_ITEMS = 8;

export interface TerminalCompletionItem extends CompletionCandidate {
  edit: CompletionEdit;
}

const directoryCache = new Map<string, { expiresAt: number; entries: FileEntry[] }>();
const packageScriptsCache = new Map<string, { expiresAt: number; scripts: string[] }>();
const gitCompletionCache = new Map<string, { expiresAt: number; data: GitCompletionData | null }>();

export function resetTerminalCompletionCaches() {
  directoryCache.clear();
  packageScriptsCache.clear();
  gitCompletionCache.clear();
}

async function readDirectory(projectPath: string, directoryPath: string) {
  const cacheKey = `${projectPath}::${directoryPath}`;
  const now = Date.now();
  const cached = directoryCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.entries;
  }

  const entries = await invoke<FileEntry[]>('complete_path_entries', {
    path: directoryPath,
  });
  directoryCache.set(cacheKey, { expiresAt: now + DIRECTORY_CACHE_TTL, entries });
  return entries;
}

async function readPackageScripts(projectPath: string, cwd: string) {
  const candidates = Array.from(
    new Set([normalizePath(cwd), normalizePath(projectPath)]),
  );

  for (const basePath of candidates) {
    const packagePath = joinPath(basePath, 'package.json');
    const cached = packageScriptsCache.get(packagePath);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.scripts;
    }

    try {
      const result = await invoke<FileContentResult>('read_file_content', { path: packagePath });
      if (result.isBinary || result.tooLarge || !result.content) {
        continue;
      }

      const parsed = JSON.parse(result.content) as { scripts?: Record<string, string> };
      const scripts = Object.keys(parsed.scripts ?? {});
      packageScriptsCache.set(packagePath, { expiresAt: now + PACKAGE_CACHE_TTL, scripts });
      return scripts;
    } catch {
      continue;
    }
  }

  return [];
}

async function readGitCompletionData(cwd: string) {
  const cacheKey = normalizePath(cwd);
  const now = Date.now();
  const cached = gitCompletionCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const data = await invoke<GitCompletionData | null>('get_git_completion_data', { cwd });
  gitCompletionCache.set(cacheKey, { expiresAt: now + GIT_COMPLETION_CACHE_TTL, data });
  return data;
}

function toTerminalItems(result: CompletionResult): TerminalCompletionItem[] {
  return result.candidates.slice(0, MAX_VISIBLE_ITEMS).map((candidate) => ({
    ...candidate,
    edit: candidateToEdit(candidate),
  }));
}

export function useTerminalCompletions(terminalId: number | string, projectPath: string, enabled = true) {
  const session = useAppStore((state) => {
    if (!enabled) {
      return undefined;
    }

    return typeof terminalId === 'string'
      ? state.terminalSessions.get(terminalId)
      : state.sessions.get(terminalId);
  });
  const completionUsage = useAppStore((state) => (enabled ? state.config.completionUsage : undefined));
  const [inputState, setInputState] = useState<TerminalInputState>(() => getTerminalInputState(terminalId));
  const [items, setItems] = useState<TerminalCompletionItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [commonPrefixEdit, setCommonPrefixEdit] = useState<CompletionEdit | undefined>(undefined);
  const requestIdRef = useRef(0);
  const selectedIdRef = useRef<string | undefined>(undefined);
  const trustedPrompt =
    enabled
    && Boolean(session)
    && (session?.phase === 'ready' || session?.phase === 'waiting-input');

  useEffect(() => {
    if (!enabled) {
      setInputState(getTerminalInputState(terminalId));
      return;
    }

    return subscribeTerminalInputState(terminalId, setInputState);
  }, [enabled, terminalId]);

  useEffect(() => {
    setMenuOpen(false);
    setSelectedIndex(0);
    selectedIdRef.current = undefined;
  }, [enabled, inputState.version, session?.phase, terminalId]);

  const runtime = useMemo(
    () => ({
      projectPath,
      usageScopeKey: normalizeUsageScopeKey(projectPath),
      sessionCommands: session?.commands.map((command) => command.command) ?? [],
      lastCommand: session?.lastCommand,
      completionUsage,
      readDirectory: (directoryPath: string) => readDirectory(projectPath, directoryPath),
      readPackageScripts: (cwd: string) => readPackageScripts(projectPath, cwd),
      readGitCompletionData: (cwd: string) => readGitCompletionData(cwd),
    }),
    [completionUsage, projectPath, session?.commands, session?.lastCommand],
  );

  useEffect(() => {
    let disposed = false;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    const timer = window.setTimeout(() => {
      void (async () => {
        if (!trustedPrompt) {
          if (!disposed) {
            setItems([]);
            setCommonPrefixEdit(undefined);
            setSelectedIndex(0);
          }
          return;
        }

        if (inputState.unsafe) {
          if (!disposed) {
            setItems([]);
            setCommonPrefixEdit(undefined);
            setSelectedIndex(0);
          }
          return;
        }

        try {
          const currentText = inputState.text;
          const currentCursor = inputState.cursor;
          if (!currentText.trim()) {
            if (!disposed) {
              setItems([]);
              setCommonPrefixEdit(undefined);
              setSelectedIndex(0);
            }
            return;
          }

          const context = createCompletionContext({
            inputText: currentText,
            cursor: currentCursor,
            shellKind: session?.shellKind ?? 'unknown',
            cwd: session?.cwd ?? projectPath,
            unsafe: inputState.unsafe,
          });

          if (context.mode === 'unknown') {
            if (!disposed) {
              setItems([]);
              setCommonPrefixEdit(undefined);
              setSelectedIndex(0);
            }
            return;
          }

          const candidates = await collectCompletionCandidates(context, runtime);
          const result = buildCompletionResult(context, candidates);

          if (disposed || requestIdRef.current !== requestId) {
            return;
          }

          const nextItems = toTerminalItems(result);
          setCommonPrefixEdit(result.commonPrefixEdit);
          setItems(nextItems);
          setSelectedIndex((current) => {
            const currentId = selectedIdRef.current;
            if (!currentId) return 0;
            const existingIndex = nextItems.findIndex((item) => item.id === currentId);
            return existingIndex >= 0 ? existingIndex : Math.min(current, Math.max(nextItems.length - 1, 0));
          });
        } catch {
          if (!disposed && requestIdRef.current === requestId) {
            setItems([]);
            setCommonPrefixEdit(undefined);
            setSelectedIndex(0);
          }
        }
      })();
    }, 80);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [inputState, projectPath, runtime, session?.cwd, session?.shellKind, trustedPrompt]);

  const visibleItems = trustedPrompt ? items : [];
  const selectedItem = visibleItems[selectedIndex] ?? visibleItems[0];

  const acceptEdit = useCallback(
    async (edit?: CompletionEdit) => {
      if (!edit) return false;
      if (isSameCompletionEdit(getTerminalInputState(terminalId), edit)) {
        setMenuOpen(false);
        return true;
      }
      const handled = await applyCompletionEdit(terminalId, edit);
      if (handled) {
        setMenuOpen(false);
        setSelectedIndex(0);
        selectedIdRef.current = undefined;
      }
      return handled;
    },
    [terminalId],
  );

  const acceptItem = useCallback(
    async (item?: TerminalCompletionItem) => {
      if (!item) return false;
      return acceptEdit(item.edit);
    },
    [acceptEdit],
  );

  const selectNext = useCallback(() => {
    if (!menuOpen || visibleItems.length <= 1) return false;
    setSelectedIndex((current) => {
      const next = (current + 1) % visibleItems.length;
      selectedIdRef.current = visibleItems[next]?.id;
      return next;
    });
    return true;
  }, [menuOpen, visibleItems]);

  const selectPrevious = useCallback(() => {
    if (!menuOpen || visibleItems.length <= 1) return false;
    setSelectedIndex((current) => {
      const next = (current - 1 + visibleItems.length) % visibleItems.length;
      selectedIdRef.current = visibleItems[next]?.id;
      return next;
    });
    return true;
  }, [menuOpen, visibleItems]);

  const closeMenu = useCallback(() => {
    if (!menuOpen) return false;
    setMenuOpen(false);
    selectedIdRef.current = undefined;
    return true;
  }, [menuOpen]);

  const acceptSelected = useCallback(async () => acceptItem(selectedItem), [acceptItem, selectedItem]);

  const canHandleTab = useCallback(
    (shiftKey: boolean) => {
      if (!trustedPrompt || visibleItems.length === 0) {
        return false;
      }

      if (shiftKey) {
        return menuOpen && visibleItems.length > 1;
      }

      return true;
    },
    [menuOpen, trustedPrompt, visibleItems.length],
  );

  const handleTab = useCallback(
    async (shiftKey: boolean) => {
      if (shiftKey) {
        return selectPrevious();
      }

      if (visibleItems.length === 0) {
        return false;
      }

      if (visibleItems.length === 1) {
        return acceptItem(visibleItems[0]);
      }

      if (!menuOpen && commonPrefixEdit) {
        return acceptEdit(commonPrefixEdit);
      }

      if (!menuOpen) {
        setMenuOpen(true);
        setSelectedIndex(0);
        selectedIdRef.current = selectedItem?.id;
        return true;
      }

      if (visibleItems.length === 1) {
        return acceptItem(visibleItems[0]);
      }

      return selectNext();
    },
    [acceptEdit, acceptItem, commonPrefixEdit, menuOpen, selectNext, selectPrevious, selectedItem, visibleItems],
  );

  const ghostText = selectedItem?.label ?? '';

  return {
    inputState,
    items: visibleItems,
    selectedIndex,
    menuOpen,
    ghostText,
    acceptItem,
    acceptSelected,
    handleTab,
    canHandleTab,
    selectNext,
    selectPrevious,
    closeMenu,
    setSelectedIndex: (index: number) => {
      setSelectedIndex(index);
      selectedIdRef.current = visibleItems[index]?.id;
    },
  };
}
