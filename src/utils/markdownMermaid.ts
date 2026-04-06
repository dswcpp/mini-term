type MermaidRenderResult = {
  svg: string;
  bindFunctions?: (element: Element) => void;
};

type MermaidModule = {
  render: (id: string, text: string) => Promise<MermaidRenderResult>;
  initialize: (config: Record<string, unknown>) => void;
};

export type MermaidStylePreset = 'default' | 'flow' | 'sequence' | 'architecture' | 'planning' | 'data';

type MermaidStylePalette = {
  shellStart: string;
  shellEnd: string;
  nodeStart: string;
  nodeMid: string;
  nodeEnd: string;
  clusterStart: string;
  clusterEnd: string;
  labelStart: string;
  labelEnd: string;
  noteStart: string;
  noteEnd: string;
  actorStart: string;
  actorEnd: string;
  accentStroke: string;
  accentStrong: string;
  accentSoft: string;
};

const MERMAID_THEME_VARIABLES = {
  background: '#161513',
  fontFamily: '"Aptos", "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif',
  primaryColor: '#241d19',
  primaryTextColor: '#f5efe8',
  primaryBorderColor: '#cf8a5d',
  secondaryColor: '#302521',
  secondaryTextColor: '#f7f1ea',
  secondaryBorderColor: '#e0a780',
  tertiaryColor: '#1d1816',
  tertiaryTextColor: '#ccb6a8',
  tertiaryBorderColor: '#775341',
  lineColor: '#cf9a79',
  textColor: '#f5efe8',
  mainBkg: '#241d19',
  clusterBkg: '#171412',
  clusterBorder: '#775341',
  defaultLinkColor: '#cf9a79',
  edgeLabelBackground: '#241d19',
  actorBkg: '#241d19',
  actorBorder: '#cf8a5d',
  actorTextColor: '#f5efe8',
  actorLineColor: '#9d6d52',
  signalColor: '#cf9a79',
  signalTextColor: '#f5efe8',
  labelBoxBkgColor: '#241d19',
  labelTextColor: '#f5efe8',
  loopTextColor: '#f5efe8',
  noteBkgColor: '#322722',
  noteBorderColor: '#d6a182',
  noteTextColor: '#f7efe7',
  sectionBkgColor: '#1b1613',
  sectionBkgColor2: '#261e1a',
  altSectionBkgColor: '#221a17',
  gridColor: 'rgba(245, 239, 232, 0.12)',
  cScale0: '#241d19',
  cScale1: '#302521',
  cScale2: '#3a2c27',
  cScale3: '#43332d',
  cScale4: '#4d3932',
  cScale5: '#5a433a',
  cScale6: '#6a4e42',
  cScale7: '#7b5c4b',
  pie1: '#cf8a5d',
  pie2: '#e0a780',
  pie3: '#f0c19d',
  pie4: '#7b5c4b',
  pie5: '#3a2c27',
  pie6: '#322722',
  pie7: '#241d19',
  pie8: '#171412',
  pie9: '#4d3932',
  pie10: '#775341',
} as const;

const MERMAID_THEME_CSS = `
.label, .nodeLabel, .edgeLabel, .cluster-label, .messageText, .loopText {
  font-weight: 600;
  letter-spacing: 0.01em;
}

.label,
.nodeLabel,
.cluster-label,
.edgeLabel {
  text-rendering: geometricPrecision;
}

.label foreignObject div,
.nodeLabel foreignObject div,
.cluster-label foreignObject div,
.edgeLabel foreignObject div {
  color: #f5efe8 !important;
  background: transparent !important;
  line-height: 1.35;
}

.node rect,
.node polygon,
.node path,
.node circle,
.node ellipse,
.actor rect,
.labelBox,
.note rect {
  filter: drop-shadow(0 12px 24px rgba(0, 0, 0, 0.22)) drop-shadow(0 2px 6px rgba(207, 138, 93, 0.08));
  stroke-width: 1.65px !important;
}

.node rect,
.cluster rect,
.labelBox,
.note {
  rx: 14px;
  ry: 14px;
}

.cluster rect {
  stroke-dasharray: 8 4;
  filter: none;
  stroke-width: 1.4px !important;
}

.cluster-label foreignObject div {
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid rgba(207, 138, 93, 0.32);
  background: linear-gradient(180deg, rgba(38, 31, 27, 0.96), rgba(23, 19, 17, 0.94)) !important;
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.22);
}

.nodeLabel foreignObject div,
.label foreignObject div {
  padding: 1px 0;
}

.edgePath .path,
.flowchart-link,
.messageLine0,
.messageLine1 {
  stroke-width: 2.4px !important;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.marker {
  fill: #cf9a79 !important;
  stroke: #cf9a79 !important;
}

.edgeLabel rect {
  fill: #241d19 !important;
  stroke: #9d6d52 !important;
  opacity: 0.98 !important;
  rx: 999px;
  ry: 999px;
  stroke-width: 1.2px !important;
}

.edgeLabel text,
.edgeLabel span {
  fill: #f5efe8 !important;
  color: #f5efe8 !important;
}

.note rect {
  stroke-width: 1.4px !important;
}

.section {
  stroke-width: 1px;
}

.task, .taskText, .taskTextOutsideRight, .taskTextOutsideLeft {
  font-weight: 600;
}

.node .label,
.cluster-label .label,
.actor .label,
.noteText {
  color: #f5efe8 !important;
}
`;

const MERMAID_STYLE_PALETTES: Record<MermaidStylePreset, MermaidStylePalette> = {
  default: {
    shellStart: '#181513',
    shellEnd: '#120f0d',
    nodeStart: '#2f2520',
    nodeMid: '#241d19',
    nodeEnd: '#1a1512',
    clusterStart: '#1d1816',
    clusterEnd: '#141110',
    labelStart: '#2e241f',
    labelEnd: '#211916',
    noteStart: '#3a2c26',
    noteEnd: '#2a201c',
    actorStart: '#312723',
    actorEnd: '#211916',
    accentStroke: '#cf9a79',
    accentStrong: '#e0a780',
    accentSoft: '#9d6d52',
  },
  flow: {
    shellStart: '#181513',
    shellEnd: '#120f0d',
    nodeStart: '#2f2520',
    nodeMid: '#241d19',
    nodeEnd: '#1a1512',
    clusterStart: '#1d1816',
    clusterEnd: '#141110',
    labelStart: '#2e241f',
    labelEnd: '#211916',
    noteStart: '#3a2c26',
    noteEnd: '#2a201c',
    actorStart: '#312723',
    actorEnd: '#211916',
    accentStroke: '#cf9a79',
    accentStrong: '#e0a780',
    accentSoft: '#9d6d52',
  },
  sequence: {
    shellStart: '#101719',
    shellEnd: '#0a1012',
    nodeStart: '#1b373d',
    nodeMid: '#132b30',
    nodeEnd: '#0d1e22',
    clusterStart: '#13252a',
    clusterEnd: '#0d171b',
    labelStart: '#183238',
    labelEnd: '#102328',
    noteStart: '#214046',
    noteEnd: '#173036',
    actorStart: '#1c3940',
    actorEnd: '#102127',
    accentStroke: '#7ad8e6',
    accentStrong: '#66c7d8',
    accentSoft: '#2f7e89',
  },
  architecture: {
    shellStart: '#12171b',
    shellEnd: '#0c1115',
    nodeStart: '#223344',
    nodeMid: '#182734',
    nodeEnd: '#101922',
    clusterStart: '#16212a',
    clusterEnd: '#0d151b',
    labelStart: '#203243',
    labelEnd: '#15212c',
    noteStart: '#2a3d4f',
    noteEnd: '#1b2935',
    actorStart: '#24384a',
    actorEnd: '#15222e',
    accentStroke: '#72b8ff',
    accentStrong: '#89c2ff',
    accentSoft: '#406989',
  },
  planning: {
    shellStart: '#121712',
    shellEnd: '#0d100d',
    nodeStart: '#2c3826',
    nodeMid: '#212a1c',
    nodeEnd: '#161c13',
    clusterStart: '#1a2118',
    clusterEnd: '#111510',
    labelStart: '#2a3524',
    labelEnd: '#1b2418',
    noteStart: '#34422e',
    noteEnd: '#232c1f',
    actorStart: '#2f3b29',
    actorEnd: '#1c2418',
    accentStroke: '#b0db96',
    accentStrong: '#9ccf89',
    accentSoft: '#5a7f50',
  },
  data: {
    shellStart: '#171312',
    shellEnd: '#100c0b',
    nodeStart: '#3a241d',
    nodeMid: '#2a1914',
    nodeEnd: '#1a0f0d',
    clusterStart: '#231511',
    clusterEnd: '#160d0b',
    labelStart: '#351f18',
    labelEnd: '#241310',
    noteStart: '#40261f',
    noteEnd: '#2c1713',
    actorStart: '#38231c',
    actorEnd: '#261511',
    accentStroke: '#f2a37f',
    accentStrong: '#ef8b66',
    accentSoft: '#8a4d39',
  },
};

export const MERMAID_SHARED_SVG_STYLE_ID = 'mini-term-mermaid-shared-svg-styles';

const MERMAID_EXPORT_SHARED_STYLE_ATTR = 'data-mini-term-mermaid-export-shared="true"';

const MERMAID_SHARED_SVG_CSS = `
svg[data-mini-term-mermaid-style] .mini-term-mermaid-shell {
  fill: var(--mini-term-mermaid-shell-fill);
}

svg[data-mini-term-mermaid-style] .mini-term-mermaid-shell-grid {
  fill: var(--mini-term-mermaid-shell-grid-fill);
  opacity: 0.5;
}

svg[data-mini-term-mermaid-style] .mini-term-mermaid-shell-border {
  fill: none;
  stroke: var(--mini-term-mermaid-shell-border-stroke);
  stroke-width: 1.2;
}

svg[data-mini-term-mermaid-style] .mini-term-mermaid-shell-accent {
  fill: var(--mini-term-mermaid-shell-accent-fill);
  opacity: 0.98;
}

svg[data-mini-term-mermaid-style] .mini-term-mermaid-shell-glow {
  fill: var(--mini-term-mermaid-shell-glow-fill);
  opacity: 0.85;
}

svg[data-mini-term-mermaid-style] .node rect,
svg[data-mini-term-mermaid-style] .node polygon,
svg[data-mini-term-mermaid-style] .node path,
svg[data-mini-term-mermaid-style] .node circle,
svg[data-mini-term-mermaid-style] .node ellipse,
svg[data-mini-term-mermaid-style] .labelBox {
  fill: var(--mini-term-mermaid-node-fill) !important;
  stroke: var(--mini-term-mermaid-node-stroke) !important;
}

svg[data-mini-term-mermaid-style] .cluster rect {
  fill: var(--mini-term-mermaid-cluster-fill) !important;
  stroke: var(--mini-term-mermaid-cluster-stroke) !important;
}

svg[data-mini-term-mermaid-style] .edgeLabel rect {
  fill: var(--mini-term-mermaid-label-fill) !important;
  stroke: var(--mini-term-mermaid-label-stroke) !important;
}

svg[data-mini-term-mermaid-style] .note rect {
  fill: var(--mini-term-mermaid-note-fill) !important;
  stroke: var(--mini-term-mermaid-note-stroke) !important;
}

svg[data-mini-term-mermaid-style] .actor rect {
  fill: var(--mini-term-mermaid-actor-fill) !important;
  stroke: var(--mini-term-mermaid-actor-stroke) !important;
}

svg[data-mini-term-mermaid-style] .edgePath .path,
svg[data-mini-term-mermaid-style] .flowchart-link,
svg[data-mini-term-mermaid-style] .messageLine0,
svg[data-mini-term-mermaid-style] .messageLine1 {
  stroke: var(--mini-term-mermaid-edge-stroke) !important;
}

svg[data-mini-term-mermaid-style] .marker {
  fill: var(--mini-term-mermaid-marker-fill) !important;
  stroke: var(--mini-term-mermaid-marker-fill) !important;
}

svg[data-mini-term-mermaid-style] .cluster-label foreignObject div {
  border-color: var(--mini-term-mermaid-cluster-label-border) !important;
  background: linear-gradient(
    180deg,
    var(--mini-term-mermaid-cluster-label-fill-start),
    var(--mini-term-mermaid-cluster-label-fill-end)
  ) !important;
  box-shadow:
    0 8px 18px rgba(0, 0, 0, 0.24),
    0 0 0 1px var(--mini-term-mermaid-cluster-label-outline);
}
`;

type MermaidSvgDecoratorRefs = {
  nodeGradientId: string;
  clusterGradientId: string;
  labelGradientId: string;
  noteGradientId: string;
  actorGradientId: string;
  shellGradientId: string;
  shellPatternId: string;
  shellGlowId: string;
  shellAccentId: string;
};

type MermaidSvgDecoratorData = {
  defsMarkup: string;
  rootStyle: string;
};

function sanitizeSvgId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.trim().replace('#', '');
  const expanded = normalized.length === 3
    ? normalized
        .split('')
        .map((value) => `${value}${value}`)
        .join('')
    : normalized;

  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    return `rgba(255, 255, 255, ${alpha})`;
  }

  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function normalizeMermaidSource(source: string) {
  return source
    .replace(/%%\{[\s\S]*?\}%%/g, ' ')
    .replace(/^\s*%%.*$/gm, ' ')
    .trim();
}

export function resolveMermaidStylePreset(source: string): MermaidStylePreset {
  const normalized = normalizeMermaidSource(source).toLowerCase();

  if (!normalized) {
    return 'default';
  }

  if (/\b(?:architecture-beta|c4context|c4container|c4component|c4dynamic|c4deployment|block-beta|classdiagram|erdiagram|requirementdiagram)\b/.test(normalized)) {
    return 'architecture';
  }

  if (/\bsequencediagram\b/.test(normalized)) {
    return 'sequence';
  }

  if (/\b(?:journey|gantt|timeline)\b/.test(normalized)) {
    return 'planning';
  }

  if (/\b(?:pie|xychart-beta|quadrantchart|sankey-beta)\b/.test(normalized)) {
    return 'data';
  }

  if (/\b(?:flowchart|graph|statediagram|statediagram-v2|gitgraph|mindmap)\b/.test(normalized)) {
    return 'flow';
  }

  return 'default';
}

function resolveSvgCanvas(svg: string) {
  const svgTagMatch = svg.match(/<svg\b([^>]*)>/i);
  const attributes = svgTagMatch?.[1] ?? '';
  const viewBoxMatch = attributes.match(/\bviewBox=(["'])([^"']+)\1/i);
  if (viewBoxMatch) {
    const [minX = 0, minY = 0, width = 0, height = 0] = viewBoxMatch[2]
      .trim()
      .split(/[\s,]+/)
      .map((value) => Number(value));

    if ([minX, minY, width, height].every((value) => Number.isFinite(value)) && width > 0 && height > 0) {
      return { minX, minY, width, height };
    }
  }

  const widthMatch = attributes.match(/\bwidth=(["'])([^"']+)\1/i);
  const heightMatch = attributes.match(/\bheight=(["'])([^"']+)\1/i);
  const width = widthMatch ? Number(widthMatch[2].replace(/[^\d.]/g, '')) : 0;
  const height = heightMatch ? Number(heightMatch[2].replace(/[^\d.]/g, '')) : 0;

  return {
    minX: 0,
    minY: 0,
    width: width > 0 ? width : 1200,
    height: height > 0 ? height : 720,
  };
}

function mergeInlineStyle(existing: string | undefined, addition: string) {
  const normalizedExisting = existing?.trim().replace(/;+\s*$/, '') ?? '';
  const normalizedAddition = addition.trim().replace(/;+\s*$/, '');

  if (!normalizedExisting) {
    return `${normalizedAddition};`;
  }

  if (!normalizedAddition) {
    return `${normalizedExisting};`;
  }

  return `${normalizedExisting}; ${normalizedAddition};`;
}

function injectSvgRootMetadata(svg: string, preset: MermaidStylePreset, rootStyle: string) {
  const presetClass = `mini-term-mermaid-preset-${preset}`;

  return svg.replace(/<svg\b([^>]*)>/i, (fullMatch, attributes) => {
    void fullMatch;
    const classMatch = attributes.match(/\bclass=(["'])([^"']*)\1/i);
    let nextAttributes = classMatch
      ? attributes.replace(
          classMatch[0],
          `class=${classMatch[1]}${classMatch[2].includes(presetClass) ? classMatch[2] : `${classMatch[2]} ${presetClass}`.trim()}${classMatch[1]}`,
        )
      : `${attributes} class="${presetClass}"`;

    const styleMatch = nextAttributes.match(/\bstyle=(["'])([^"']*)\1/i);
    const mergedStyle = mergeInlineStyle(styleMatch?.[2], rootStyle);
    nextAttributes = styleMatch
      ? nextAttributes.replace(styleMatch[0], `style=${styleMatch[1]}${mergedStyle}${styleMatch[1]}`)
      : `${nextAttributes} style="${mergedStyle}"`;

    if (/\bdata-mini-term-mermaid-style=/.test(nextAttributes)) {
      return `<svg${nextAttributes}>`;
    }

    return `<svg${nextAttributes} data-mini-term-mermaid-style="${preset}">`;
  });
}

function buildMermaidShellPattern(patternId: string, preset: MermaidStylePreset, palette: MermaidStylePalette) {
  switch (preset) {
    case 'sequence':
      return `
  <pattern id="${patternId}" width="56" height="32" patternUnits="userSpaceOnUse">
    <path d="M 0 16 H 56 M 0 32 H 56" fill="none" stroke="${hexToRgba(palette.accentSoft, 0.2)}" stroke-width="1" />
    <path d="M 14 0 V 32 M 42 0 V 32" fill="none" stroke="${hexToRgba(palette.accentStrong, 0.08)}" stroke-width="1" />
  </pattern>`;
    case 'architecture':
      return `
  <pattern id="${patternId}" width="40" height="40" patternUnits="userSpaceOnUse">
    <path d="M 40 0 L 0 0 0 40" fill="none" stroke="${hexToRgba(palette.accentSoft, 0.18)}" stroke-width="1" />
    <path d="M 20 0 V 40 M 0 20 H 40" fill="none" stroke="${hexToRgba(palette.accentStrong, 0.08)}" stroke-width="1" />
  </pattern>`;
    case 'planning':
      return `
  <pattern id="${patternId}" width="36" height="36" patternUnits="userSpaceOnUse">
    <path d="M 0 12 H 36 M 0 24 H 36" fill="none" stroke="${hexToRgba(palette.accentSoft, 0.17)}" stroke-width="1" />
    <path d="M 12 0 V 36 M 24 0 V 36" fill="none" stroke="${hexToRgba(palette.accentStrong, 0.08)}" stroke-width="1" />
  </pattern>`;
    case 'data':
      return `
  <pattern id="${patternId}" width="24" height="24" patternUnits="userSpaceOnUse">
    <circle cx="12" cy="12" r="1.5" fill="${hexToRgba(palette.accentStrong, 0.34)}" />
  </pattern>`;
    default:
      return `
  <pattern id="${patternId}" width="28" height="28" patternUnits="userSpaceOnUse">
    <path d="M 28 0 L 0 0 0 28" fill="none" stroke="${hexToRgba(palette.accentSoft, 0.16)}" stroke-width="1" />
  </pattern>`;
  }
}

function buildMermaidSvgRootStyle(refs: MermaidSvgDecoratorRefs, palette: MermaidStylePalette) {
  return [
    `--mini-term-mermaid-shell-fill:url(#${refs.shellGradientId})`,
    `--mini-term-mermaid-shell-grid-fill:url(#${refs.shellPatternId})`,
    `--mini-term-mermaid-shell-border-stroke:${hexToRgba(palette.accentStrong, 0.26)}`,
    `--mini-term-mermaid-shell-accent-fill:url(#${refs.shellAccentId})`,
    `--mini-term-mermaid-shell-glow-fill:url(#${refs.shellGlowId})`,
    `--mini-term-mermaid-node-fill:url(#${refs.nodeGradientId})`,
    `--mini-term-mermaid-node-stroke:${palette.accentSoft}`,
    `--mini-term-mermaid-cluster-fill:url(#${refs.clusterGradientId})`,
    `--mini-term-mermaid-cluster-stroke:${hexToRgba(palette.accentSoft, 0.9)}`,
    `--mini-term-mermaid-label-fill:url(#${refs.labelGradientId})`,
    `--mini-term-mermaid-label-stroke:${palette.accentSoft}`,
    `--mini-term-mermaid-note-fill:url(#${refs.noteGradientId})`,
    `--mini-term-mermaid-note-stroke:${palette.accentSoft}`,
    `--mini-term-mermaid-actor-fill:url(#${refs.actorGradientId})`,
    `--mini-term-mermaid-actor-stroke:${palette.accentStrong}`,
    `--mini-term-mermaid-edge-stroke:${palette.accentStroke}`,
    `--mini-term-mermaid-marker-fill:${palette.accentStroke}`,
    `--mini-term-mermaid-cluster-label-border:${hexToRgba(palette.accentStrong, 0.34)}`,
    `--mini-term-mermaid-cluster-label-fill-start:${hexToRgba(palette.clusterStart, 0.96)}`,
    `--mini-term-mermaid-cluster-label-fill-end:${hexToRgba(palette.clusterEnd, 0.94)}`,
    `--mini-term-mermaid-cluster-label-outline:${hexToRgba(palette.accentSoft, 0.12)}`,
  ].join(';');
}

export function ensureMermaidSharedSvgStyles(targetDocument?: Document | null) {
  const activeDocument = targetDocument ?? (typeof document !== 'undefined' ? document : null);
  if (!activeDocument?.head || activeDocument.getElementById(MERMAID_SHARED_SVG_STYLE_ID)) {
    return;
  }

  const styleElement = activeDocument.createElement('style');
  styleElement.id = MERMAID_SHARED_SVG_STYLE_ID;
  styleElement.textContent = MERMAID_SHARED_SVG_CSS;
  activeDocument.head.appendChild(styleElement);
}

export function materializeMermaidSvgForExport(svg: string) {
  if (!svg.includes('<svg') || svg.includes(MERMAID_EXPORT_SHARED_STYLE_ATTR)) {
    return svg;
  }

  const styleMarkup = `<style ${MERMAID_EXPORT_SHARED_STYLE_ATTR}>${MERMAID_SHARED_SVG_CSS}</style>`;
  if (/<defs\b[^>]*>/i.test(svg)) {
    return svg.replace(/<\/defs>/i, `</defs>${styleMarkup}`);
  }

  return svg.replace(/(<svg\b[^>]*>)/i, `$1${styleMarkup}`);
}

function buildMermaidSvgDecorators(diagramId: string, preset: MermaidStylePreset): MermaidSvgDecoratorData {
  const safeId = sanitizeSvgId(diagramId);
  const palette = MERMAID_STYLE_PALETTES[preset];
  const refs: MermaidSvgDecoratorRefs = {
    nodeGradientId: `${safeId}-node-fill`,
    clusterGradientId: `${safeId}-cluster-fill`,
    labelGradientId: `${safeId}-label-fill`,
    noteGradientId: `${safeId}-note-fill`,
    actorGradientId: `${safeId}-actor-fill`,
    shellGradientId: `${safeId}-shell-fill`,
    shellPatternId: `${safeId}-shell-grid`,
    shellGlowId: `${safeId}-shell-glow`,
    shellAccentId: `${safeId}-shell-accent`,
  };

  return {
    rootStyle: buildMermaidSvgRootStyle(refs, palette),
    defsMarkup: `
<defs>
  <linearGradient id="${refs.nodeGradientId}" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" stop-color="${palette.nodeStart}" />
    <stop offset="52%" stop-color="${palette.nodeMid}" />
    <stop offset="100%" stop-color="${palette.nodeEnd}" />
  </linearGradient>
  <linearGradient id="${refs.clusterGradientId}" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" stop-color="${palette.clusterStart}" />
    <stop offset="100%" stop-color="${palette.clusterEnd}" />
  </linearGradient>
  <linearGradient id="${refs.labelGradientId}" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" stop-color="${palette.labelStart}" />
    <stop offset="100%" stop-color="${palette.labelEnd}" />
  </linearGradient>
  <linearGradient id="${refs.noteGradientId}" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" stop-color="${palette.noteStart}" />
    <stop offset="100%" stop-color="${palette.noteEnd}" />
  </linearGradient>
  <linearGradient id="${refs.actorGradientId}" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" stop-color="${palette.actorStart}" />
    <stop offset="100%" stop-color="${palette.actorEnd}" />
  </linearGradient>
  <linearGradient id="${refs.shellGradientId}" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" stop-color="${palette.shellStart}" />
    <stop offset="100%" stop-color="${palette.shellEnd}" />
  </linearGradient>
  <linearGradient id="${refs.shellAccentId}" x1="0%" y1="0%" x2="100%" y2="0%">
    <stop offset="0%" stop-color="${palette.accentStrong}" />
    <stop offset="100%" stop-color="${palette.accentStroke}" />
  </linearGradient>
  <radialGradient id="${refs.shellGlowId}" cx="70%" cy="18%" r="62%">
    <stop offset="0%" stop-color="${hexToRgba(palette.accentStrong, 0.3)}" />
    <stop offset="100%" stop-color="${hexToRgba(palette.accentStrong, 0)}" />
  </radialGradient>
${buildMermaidShellPattern(refs.shellPatternId, preset, palette)}
</defs>
`,
  };
}

export function decorateMermaidSvgMarkup(svg: string, diagramId: string, preset: MermaidStylePreset = 'default') {
  if (!svg.includes('<svg')) {
    return svg;
  }

  const canvas = resolveSvgCanvas(svg);
  ensureMermaidSharedSvgStyles();
  const decorators = buildMermaidSvgDecorators(diagramId, preset);
  const decoratedRoot = injectSvgRootMetadata(svg, preset, decorators.rootStyle);
  const shellInset = Math.max(10, Math.min(canvas.width, canvas.height) * 0.018);
  const shellRadius = Math.max(18, Math.min(canvas.width, canvas.height) * 0.035);
  const shellAccentHeight = Math.max(8, Math.min(18, canvas.height * 0.024));
  const shellInnerWidth = Math.max(0, canvas.width - shellInset * 2);
  const shellInnerHeight = Math.max(0, canvas.height - shellInset * 2);
  const shellMarkup = `
<g class="mini-term-mermaid-canvas-shell" aria-hidden="true">
  <ellipse
    class="mini-term-mermaid-shell-glow"
    cx="${canvas.minX + shellInset + shellInnerWidth * 0.72}"
    cy="${canvas.minY + shellInset + shellInnerHeight * 0.18}"
    rx="${Math.max(40, shellInnerWidth * 0.28)}"
    ry="${Math.max(28, shellInnerHeight * 0.18)}"
  />
  <rect
    class="mini-term-mermaid-shell"
    x="${canvas.minX + shellInset}"
    y="${canvas.minY + shellInset}"
    width="${shellInnerWidth}"
    height="${shellInnerHeight}"
    rx="${shellRadius}"
    ry="${shellRadius}"
  />
  <rect
    class="mini-term-mermaid-shell-grid"
    x="${canvas.minX + shellInset}"
    y="${canvas.minY + shellInset}"
    width="${shellInnerWidth}"
    height="${shellInnerHeight}"
    rx="${shellRadius}"
    ry="${shellRadius}"
  />
  <rect
    class="mini-term-mermaid-shell-accent"
    x="${canvas.minX + shellInset}"
    y="${canvas.minY + shellInset}"
    width="${shellInnerWidth}"
    height="${shellAccentHeight}"
    rx="${shellRadius}"
    ry="${shellRadius}"
  />
  <rect
    class="mini-term-mermaid-shell-border"
    x="${canvas.minX + shellInset}"
    y="${canvas.minY + shellInset}"
    width="${shellInnerWidth}"
    height="${shellInnerHeight}"
    rx="${shellRadius}"
    ry="${shellRadius}"
  />
</g>`;

  return decoratedRoot.replace(/(<svg\b[^>]*>)/i, `$1${decorators.defsMarkup}${shellMarkup}`);
}

let mermaidModulePromise: Promise<MermaidModule> | null = null;
let mermaidInitialized = false;

export function getMermaidInitializationConfig() {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    fontFamily: MERMAID_THEME_VARIABLES.fontFamily,
    themeVariables: MERMAID_THEME_VARIABLES,
    themeCSS: MERMAID_THEME_CSS,
    flowchart: {
      htmlLabels: true,
      useMaxWidth: false,
      padding: 12,
      nodeSpacing: 40,
      rankSpacing: 56,
      curve: 'basis',
    },
    sequence: {
      useMaxWidth: false,
      actorMargin: 48,
      boxMargin: 16,
      boxTextMargin: 10,
      diagramMarginX: 24,
      diagramMarginY: 18,
      messageMargin: 26,
      noteMargin: 14,
      bottomMarginAdj: 12,
    },
    journey: {
      useMaxWidth: false,
    },
    gantt: {
      useMaxWidth: false,
    },
  } as const;
}

async function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then((module) => module.default);
  }

  const mermaid = await mermaidModulePromise;
  if (!mermaidInitialized) {
    mermaid.initialize(getMermaidInitializationConfig());
    mermaidInitialized = true;
  }

  return mermaid;
}

export async function renderMermaidDiagram(source: string, diagramId: string) {
  const mermaid = await loadMermaid();
  const rendered = await mermaid.render(diagramId, source);
  const preset = resolveMermaidStylePreset(source);
  return {
    ...rendered,
    svg: decorateMermaidSvgMarkup(rendered.svg, diagramId, preset),
  };
}
