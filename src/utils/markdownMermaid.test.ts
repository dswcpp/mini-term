import { beforeEach, describe, expect, it } from 'vitest';
import {
  decorateMermaidSvgMarkup,
  getMermaidInitializationConfig,
  materializeMermaidSvgForExport,
  MERMAID_SHARED_SVG_STYLE_ID,
  resolveMermaidStylePreset,
} from './markdownMermaid';

describe('getMermaidInitializationConfig', () => {
  beforeEach(() => {
    document.getElementById(MERMAID_SHARED_SVG_STYLE_ID)?.remove();
  });

  it('uses the custom base theme and Mini-Term styling tokens', () => {
    const config = getMermaidInitializationConfig();

    expect(config.theme).toBe('base');
    expect(config.securityLevel).toBe('strict');
    expect(config.flowchart).toMatchObject({
      htmlLabels: true,
      useMaxWidth: false,
      curve: 'basis',
    });
    expect(config.themeVariables).toMatchObject({
      primaryColor: '#241d19',
      primaryBorderColor: '#cf8a5d',
      lineColor: '#cf9a79',
      clusterBkg: '#171412',
    });
    expect(config.themeCSS).toContain('.edgePath .path');
    expect(config.themeCSS).toContain('drop-shadow');
    expect(config.themeCSS).toContain('.edgeLabel rect');
    expect(config.themeCSS).toContain('.cluster-label foreignObject div');
  });

  it('classifies Mermaid sources into visual style presets', () => {
    expect(resolveMermaidStylePreset('flowchart TD\n  A --> B')).toBe('flow');
    expect(resolveMermaidStylePreset('sequenceDiagram\n  A->>B: ping')).toBe('sequence');
    expect(resolveMermaidStylePreset('classDiagram\n  Engine --> Wheel')).toBe('architecture');
    expect(resolveMermaidStylePreset('gantt\n  title Launch')).toBe('planning');
    expect(resolveMermaidStylePreset('pie title Revenue\n  "North" : 42')).toBe('data');
    expect(resolveMermaidStylePreset('%% comment only')).toBe('default');
  });

  it('decorates rendered svg with Mini-Term gradients, preset metadata, and scoped ids', () => {
    const svg = '<svg viewBox="0 0 100 100"><g class="node"><rect width="80" height="32" /></g></svg>';
    const decorated = decorateMermaidSvgMarkup(svg, 'mini-term-mermaid-42', 'flow');
    const sharedStyle = document.getElementById(MERMAID_SHARED_SVG_STYLE_ID);

    expect(decorated).toContain('<defs>');
    expect(decorated).toContain('mini-term-mermaid-42-node-fill');
    expect(decorated).toContain('mini-term-mermaid-preset-flow');
    expect(decorated).toContain('data-mini-term-mermaid-style="flow"');
    expect(decorated).toContain('--mini-term-mermaid-node-fill:url(#mini-term-mermaid-42-node-fill)');
    expect(decorated).toContain('--mini-term-mermaid-shell-accent-fill:url(#mini-term-mermaid-42-shell-accent)');
    expect(decorated).toContain('--mini-term-mermaid-shell-glow-fill:url(#mini-term-mermaid-42-shell-glow)');
    expect(decorated).toContain('class="mini-term-mermaid-shell-accent"');
    expect(decorated).toContain('class="mini-term-mermaid-shell-glow"');
    expect(sharedStyle?.textContent).toContain('svg[data-mini-term-mermaid-style] .cluster rect');
    expect(sharedStyle?.textContent).toContain('svg[data-mini-term-mermaid-style] .actor rect');
  });

  it('injects the shared Mermaid svg stylesheet only once and reuses it across diagrams', () => {
    const svg = '<svg viewBox="0 0 100 100"><g class="node"><rect width="80" height="32" /></g></svg>';

    decorateMermaidSvgMarkup(svg, 'mini-term-mermaid-1', 'flow');
    decorateMermaidSvgMarkup(svg, 'mini-term-mermaid-2', 'sequence');

    expect(document.querySelectorAll(`#${MERMAID_SHARED_SVG_STYLE_ID}`)).toHaveLength(1);
  });

  it('uses family-specific shell patterns for sequence and data diagrams', () => {
    const svg = '<svg viewBox="0 0 100 100"><g class="node"><rect width="80" height="32" /></g></svg>';
    const sequenceDecorated = decorateMermaidSvgMarkup(svg, 'mini-term-mermaid-sequence', 'sequence');
    const dataDecorated = decorateMermaidSvgMarkup(svg, 'mini-term-mermaid-data', 'data');

    expect(sequenceDecorated).toContain('M 0 16 H 56');
    expect(sequenceDecorated).toContain('data-mini-term-mermaid-style="sequence"');
    expect(dataDecorated).toContain('<circle cx="12" cy="12" r="1.5"');
    expect(dataDecorated).toContain('data-mini-term-mermaid-style="data"');
  });

  it('materializes shared Mermaid svg styles for export without duplicating them', () => {
    const svg = '<svg viewBox="0 0 100 100"><g class="node"><rect width="80" height="32" /></g></svg>';
    const decorated = decorateMermaidSvgMarkup(svg, 'mini-term-mermaid-export', 'architecture');
    const materialized = materializeMermaidSvgForExport(decorated);

    expect(materialized).toContain('data-mini-term-mermaid-export-shared="true"');
    expect(materialized).toContain('svg[data-mini-term-mermaid-style] .mini-term-mermaid-shell');
    expect(materialized).toContain('--mini-term-mermaid-node-fill:url(#mini-term-mermaid-export-node-fill)');
    expect(materializeMermaidSvgForExport(materialized)).toBe(materialized);
  });
});
