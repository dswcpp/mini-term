import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FileContentResult } from '../../types';

interface DocumentContentState {
  result: FileContentResult | null;
  loading: boolean;
  refreshing: boolean;
  error: string;
}

const INITIAL_STATE: DocumentContentState = {
  result: null,
  loading: false,
  refreshing: false,
  error: '',
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
    }));

    try {
      const result = await invoke<FileContentResult>('read_file_content', { path: filePath });
      if (requestVersionRef.current !== requestVersion) {
        return false;
      }

      setState({
        result,
        loading: false,
        refreshing: false,
        error: '',
      });
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
