type MermaidRenderResult = {
  svg: string;
  bindFunctions?: (element: Element) => void;
};

let mermaidModulePromise: Promise<{ render: (id: string, text: string) => Promise<MermaidRenderResult>; initialize: (config: Record<string, unknown>) => void; }> | null = null;
let mermaidInitialized = false;

async function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then((module) => module.default);
  }

  const mermaid = await mermaidModulePromise;
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'dark',
      fontFamily: 'DM Sans, system-ui, sans-serif',
    });
    mermaidInitialized = true;
  }

  return mermaid;
}

export async function renderMermaidDiagram(source: string, diagramId: string) {
  const mermaid = await loadMermaid();
  return mermaid.render(diagramId, source);
}
