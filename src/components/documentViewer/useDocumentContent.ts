import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FileContentResult } from '../../types';

interface DocumentContentState {
  result: FileContentResult | null;
  loading: boolean;
  error: string;
}

const INITIAL_STATE: DocumentContentState = {
  result: null,
  loading: false,
  error: '',
};

export function useDocumentContent(filePath: string, enabled: boolean) {
  const [state, setState] = useState<DocumentContentState>(INITIAL_STATE);
  const requestVersionRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const requestVersion = ++requestVersionRef.current;
    setState({
      result: null,
      loading: true,
      error: '',
    });

    invoke<FileContentResult>('read_file_content', { path: filePath })
      .then((result) => {
        if (requestVersionRef.current !== requestVersion) {
          return;
        }

        setState({
          result,
          loading: false,
          error: '',
        });
      })
      .catch((reason) => {
        if (requestVersionRef.current !== requestVersion) {
          return;
        }

        setState({
          result: null,
          loading: false,
          error: String(reason),
        });
      });
  }, [enabled, filePath]);

  return state;
}
