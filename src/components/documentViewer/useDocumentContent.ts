import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DocumentPreviewResult } from '../../types';

interface DocumentContentState {
  result: DocumentPreviewResult | null;
  loading: boolean;
  refreshing: boolean;
  error: string;
  version: number;
}

const INITIAL_STATE: DocumentContentState = {
  result: null,
  loading: false,
  refreshing: false,
  error: '',
  version: 0,
};

export function useDocumentContent(filePath: string, enabled: boolean) {
  const [state, setState] = useState<DocumentContentState>(INITIAL_STATE);
  const requestVersionRef = useRef(0);

  const reload = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    const requestVersion = ++requestVersionRef.current;

    setState((current) => ({
      result: silent ? current.result : null,
      loading: !silent,
      refreshing: silent,
      error: '',
      version: current.version,
    }));

    try {
      const result = await invoke<DocumentPreviewResult>('read_document_preview', { path: filePath });
      if (requestVersionRef.current !== requestVersion) {
        return false;
      }

      setState((current) => ({
        result,
        loading: false,
        refreshing: false,
        error: '',
        version: current.version + 1,
      }));
      return true;
    } catch (reason) {
      if (requestVersionRef.current !== requestVersion) {
        return false;
      }

      setState((current) => ({
        result: silent ? current.result : null,
        loading: false,
        refreshing: false,
        error: String(reason),
        version: current.version,
      }));
      return false;
    }
  }, [filePath]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    void reload();
  }, [enabled, reload]);

  return {
    ...state,
    reload,
  };
}
