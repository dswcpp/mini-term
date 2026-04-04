import { useEffect, useRef, useState } from 'react';
import { renderMermaidDiagram } from '../../utils/markdownMermaid';

export function useMermaidDiagram(source: string, diagramId: string, enabled = true) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const bindFunctionsRef = useRef<((element: Element) => void) | undefined>(undefined);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;

    setSvg('');
    setError('');
    bindFunctionsRef.current = undefined;

    renderMermaidDiagram(source, diagramId)
      .then((result) => {
        if (cancelled) {
          return;
        }

        setSvg(result.svg);
        bindFunctionsRef.current = result.bindFunctions;
      })
      .catch((reason) => {
        if (cancelled) {
          return;
        }

        setError(reason instanceof Error ? reason.message : String(reason));
      });

    return () => {
      cancelled = true;
      bindFunctionsRef.current = undefined;
    };
  }, [diagramId, enabled, source]);

  return {
    svg,
    error,
    bindFunctions: bindFunctionsRef.current,
  };
}
