type MockCanvasContext2D = {
  canvas: HTMLCanvasElement | null;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  globalAlpha: number;
  measureText: (text: string) => TextMetrics;
  getImageData: (sx: number, sy: number, sw: number, sh: number) => ImageData;
  createImageData: (sw: number, sh: number) => ImageData;
  putImageData: (...args: unknown[]) => void;
  drawImage: (...args: unknown[]) => void;
  clearRect: (...args: unknown[]) => void;
  fillRect: (...args: unknown[]) => void;
  strokeRect: (...args: unknown[]) => void;
  beginPath: () => void;
  closePath: () => void;
  moveTo: (...args: unknown[]) => void;
  lineTo: (...args: unknown[]) => void;
  bezierCurveTo: (...args: unknown[]) => void;
  quadraticCurveTo: (...args: unknown[]) => void;
  arc: (...args: unknown[]) => void;
  rect: (...args: unknown[]) => void;
  fill: (...args: unknown[]) => void;
  stroke: (...args: unknown[]) => void;
  clip: (...args: unknown[]) => void;
  save: () => void;
  restore: () => void;
  scale: (...args: unknown[]) => void;
  rotate: (...args: unknown[]) => void;
  translate: (...args: unknown[]) => void;
  transform: (...args: unknown[]) => void;
  setTransform: (...args: unknown[]) => void;
  resetTransform: () => void;
  fillText: (...args: unknown[]) => void;
  strokeText: (...args: unknown[]) => void;
};

const mockContextCache = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();

function createImageData(sw: number, sh: number): ImageData {
  return {
    data: new Uint8ClampedArray(sw * sh * 4),
    width: sw,
    height: sh,
    colorSpace: 'srgb',
  } as ImageData;
}

function createMockContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  return {
    canvas,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '10px sans-serif',
    globalAlpha: 1,
    measureText: (text: string) =>
      ({
        width: text.length * 8,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: text.length * 8,
        fontBoundingBoxAscent: 8,
        fontBoundingBoxDescent: 2,
        emHeightAscent: 8,
        emHeightDescent: 2,
        hangingBaseline: 8,
        alphabeticBaseline: 0,
        ideographicBaseline: 0,
      }) as TextMetrics,
    getImageData: (_sx: number, _sy: number, sw: number, sh: number) => createImageData(sw, sh),
    createImageData: (sw: number, sh: number) => createImageData(sw, sh),
    putImageData: () => {},
    drawImage: () => {},
    clearRect: () => {},
    fillRect: () => {},
    strokeRect: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    bezierCurveTo: () => {},
    quadraticCurveTo: () => {},
    arc: () => {},
    rect: () => {},
    fill: () => {},
    stroke: () => {},
    clip: () => {},
    save: () => {},
    restore: () => {},
    scale: () => {},
    rotate: () => {},
    translate: () => {},
    transform: () => {},
    setTransform: () => {},
    resetTransform: () => {},
    fillText: () => {},
    strokeText: () => {},
  } as unknown as CanvasRenderingContext2D;
}

function getMockContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const cached = mockContextCache.get(canvas);
  if (cached) {
    return cached;
  }

  const context = createMockContext(canvas);
  mockContextCache.set(canvas, context);
  return context;
}

function defineCanvasMethod<K extends keyof HTMLCanvasElement>(
  key: K,
  value: HTMLCanvasElement[K],
) {
  Object.defineProperty(HTMLCanvasElement.prototype, key, {
    configurable: true,
    writable: true,
    value,
  });
}

if (typeof HTMLCanvasElement !== 'undefined') {
  defineCanvasMethod('getContext', function getContext(this: HTMLCanvasElement, contextId: string) {
    if (contextId === '2d') {
      return getMockContext(this);
    }
    return null;
  } as HTMLCanvasElement['getContext']);

  defineCanvasMethod('toDataURL', (() => 'data:image/png;base64,') as HTMLCanvasElement['toDataURL']);

  defineCanvasMethod(
    'toBlob',
    ((callback: BlobCallback, type?: string) => {
      callback(new Blob([], { type: type ?? 'image/png' }));
    }) as HTMLCanvasElement['toBlob'],
  );
}
