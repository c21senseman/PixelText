import { SparseDocument } from "./document";
import { isGlyphSelected } from "./coverage";
import { graphemeWidth, segmentGraphemes } from "./graphemes";
import {
  Bookmark,
  Bounds,
  Camera,
  Position,
  SearchResult,
  Selection,
} from "./types";

export const BASE_CELL_WIDTH = 12;
export const BASE_CELL_HEIGHT = 24;
import { BASE_FONT_SIZE, BASE_FONT_PIXELS, DEFAULT_TEXT_STYLE, type TextStyle } from "./formatting";
import { getTextLayout, type LayoutGlyph } from "./layout";
const CANVAS_FONT_FAMILY =
  '"SFMono-Regular", "Cascadia Code", Consolas, "D2Coding", "Nanum Gothic Coding", "Noto Sans Mono CJK KR", monospace';

export type Viewport = {
  width: number;
  height: number;
};

export type SelectionPreview = {
  dx: number;
  dy: number;
};

export type DrawEditorOptions = {
  document: SparseDocument;
  bookmarks: Bookmark[];
  camera: Camera;
  cursor: Position;
  overwriteMode: boolean;
  selection: Selection | null;
  composition: string;
  typingStyle?: TextStyle;
  searchResults: SearchResult[];
  activeSearchIndex: number;
  searchLength: number;
  selectionPreview?: SelectionPreview | null;
  selectionResizePreview?: Selection | null;
};

export function shouldDrawCursor({
  selection,
}: Pick<DrawEditorOptions, "selection" | "overwriteMode">): boolean {
  return selection === null;
}

export function cellMetrics(camera: Camera): { width: number; height: number } {
  return {
    width: BASE_CELL_WIDTH * camera.zoom,
    height: BASE_CELL_HEIGHT * camera.zoom,
  };
}

export function screenToCell(
  screenX: number,
  screenY: number,
  camera: Camera,
  viewport: Viewport,
  document?: SparseDocument,
): Position {
  const metrics = cellMetrics(camera);
  const world = {
    x: camera.x + (screenX - viewport.width / 2) / metrics.width,
    y: camera.y + (screenY - viewport.height / 2) / metrics.height,
  };
  const logical = document ? getTextLayout(document).toLogical(world) : world;
  return { x: Math.floor(logical.x + 1e-9), y: Math.floor(logical.y + 1e-9) };
}

export function logicalToScreen(
  position: Position,
  camera: Camera,
  viewport: Viewport,
  document?: SparseDocument,
): Position {
  if (document) position = getTextLayout(document).toWorld(position);
  const metrics = cellMetrics(camera);
  return {
    x: (position.x - camera.x) * metrics.width + viewport.width / 2,
    y: (position.y - camera.y) * metrics.height + viewport.height / 2,
  };
}

// Keep a small pixel margin; for oversized selections follow the changing edge.
export function cameraToReveal(
  camera: Camera,
  viewport: Viewport,
  target: Selection,
  previous?: Selection,
): Camera {
  if (viewport.width <= 0 || viewport.height <= 0) return camera;
  const metrics = cellMetrics(camera);
  const revealAxis = (center: number, pixels: number, cellSize: number,
    start: number, end: number, oldStart?: number, oldEnd?: number) => {
    const half = Math.max(0, pixels / 2 - Math.min(24, pixels / 4)) / cellSize;
    if (end - start > half * 2) {
      if (oldEnd !== undefined && end > oldEnd) start = end;
      else if (oldStart !== undefined && start < oldStart) end = start;
      else return center;
    }
    if (start < center - half) return start + half;
    if (end > center + half) return end - half;
    return center;
  };
  return {
    ...camera,
    x: revealAxis(camera.x, viewport.width, metrics.width, target.x1, target.x2, previous?.x1, previous?.x2),
    y: revealAxis(camera.y, viewport.height, metrics.height, target.y1, target.y2, previous?.y1, previous?.y2),
  };
}

export function viewportCellBounds(camera: Camera, viewport: Viewport): Selection {
  const metrics = cellMetrics(camera);
  return {
    x1: Math.floor(camera.x - viewport.width / 2 / metrics.width) - 1,
    y1: Math.floor(camera.y - viewport.height / 2 / metrics.height) - 1,
    x2: Math.ceil(camera.x + viewport.width / 2 / metrics.width) + 1,
    y2: Math.ceil(camera.y + viewport.height / 2 / metrics.height) + 1,
  };
}

export function resizeCanvas(canvas: HTMLCanvasElement, maxDpr = 2.5): {
  context: CanvasRenderingContext2D;
  viewport: Viewport;
  dpr: number;
} | null {
  const context = canvas.getContext("2d");
  if (!context) return null;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return {
    context,
    viewport: { width: rect.width, height: rect.height },
    dpr,
  };
}

function drawGlyph(
  context: CanvasRenderingContext2D,
  glyph: Pick<LayoutGlyph, "text" | "style" | "rect">,
  camera: Camera,
  viewport: Viewport,
  color = "#252521",
): void {
  const screen = logicalToScreen({ x: glyph.rect.x1, y: glyph.rect.y1 }, camera, viewport);
  const metrics = cellMetrics(camera);
  const width = (glyph.rect.x2 - glyph.rect.x1) * metrics.width;
  const height = (glyph.rect.y2 - glyph.rect.y1) * metrics.height;
  const style = glyph.style;
  context.save();
  context.font = `${style.italic ? "italic " : ""}${style.bold ? "700 " : "400 "}${Math.max(1, style.fontSize * BASE_FONT_PIXELS * camera.zoom)}px ${CANVAS_FONT_FAMILY}`;
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.fillStyle = color;
  context.beginPath();
  context.rect(screen.x, screen.y, width, height);
  context.clip();
  context.fillText(glyph.text, screen.x + width / 2, screen.y + height * 0.8, width * 0.96);
  context.strokeStyle = color;
  context.lineWidth = Math.max(0.7, style.fontSize * BASE_FONT_PIXELS * camera.zoom / 16);
  for (const fraction of [style.underline ? 0.91 : null, style.strikethrough ? 0.52 : null]) {
    if (fraction === null) continue;
    context.beginPath();
    context.moveTo(screen.x + width * 0.04, screen.y + height * fraction);
    context.lineTo(screen.x + width * 0.96, screen.y + height * fraction);
    context.stroke();
  }
  context.restore();
}

export function drawEditorCanvas(canvas: HTMLCanvasElement, options: DrawEditorOptions): void {
  const resized = resizeCanvas(canvas);
  if (!resized) return;
  const { context, viewport } = resized;
  const metrics = cellMetrics(options.camera);
  const visible = viewportCellBounds(options.camera, viewport);
  const layout = getTextLayout(options.document);
  const typingStyle = options.typingStyle ?? DEFAULT_TEXT_STYLE;
  context.clearRect(0, 0, viewport.width, viewport.height);
  context.fillStyle = "#f7f7f4";
  context.fillRect(0, 0, viewport.width, viewport.height);
  layout.forEachVisible(visible, (glyph) => {
    const selection = options.selectionResizePreview ?? options.selection;
    const selected = selection && isGlyphSelected({ x: glyph.rect.x1, y: glyph.rect.y1,
      width: glyph.rect.x2 - glyph.rect.x1, height: glyph.rect.y2 - glyph.rect.y1 }, selection);
    drawGlyph(context, glyph, options.camera, viewport, selected ? "rgba(49,62,199,0.94)" : undefined);
  });

  if (options.selection) {
    const selection = options.selection;
    const preview = options.selectionPreview;
    const source = layout.selectionBounds(selection);
    const target = preview ? layout.toWorld({ x: selection.x1 + preview.dx, y: selection.y1 + preview.dy }) : null;
    const origin = layout.toWorld({ x: selection.x1, y: selection.y1 });
    const dx = target ? target.x - origin.x : 0;
    const dy = target ? target.y - origin.y : 0;
    const translate = (r: Selection): Selection => ({ x1: r.x1 + dx, y1: r.y1 + dy, x2: r.x2 + dx, y2: r.y2 + dy });
    if (preview || options.selectionResizePreview) {
      drawSelection(context, source, options.camera, viewport, visible, "rgba(57,70,61,0.06)", "rgba(57,70,61,0.24)");
    }
    const shown = options.selectionResizePreview ?? selection;
    for (const rect of layout.selectionRects(shown)) {
      drawSelection(context, translate(rect), options.camera, viewport, visible,
        "rgba(92,105,246,0.16)", "transparent");
    }
    drawSelection(context, translate(layout.selectionBounds(shown)), options.camera, viewport, visible,
      "transparent", "rgba(77,91,229,0.7)", true);
    if (preview && (dx || dy)) {
      options.document.forEachInSelection(selection, (x, y, text) => {
        const style = options.document.getStyle(x, y);
        const rect = translate(layout.caretRect({ x, y }, style, graphemeWidth(text)));
        if (rect.x2 > visible.x1 && rect.x1 < visible.x2 && rect.y2 > visible.y1 && rect.y1 < visible.y2) {
          drawGlyph(context, { text, style, rect }, options.camera, viewport, "rgba(49,62,199,0.94)");
        }
      }, true);
    }
  }

  const overwriteText = options.document.getCell(options.cursor.x, options.cursor.y);
  const cursorStyle = options.overwriteMode && overwriteText ? options.document.getStyle(options.cursor.x, options.cursor.y) : typingStyle;
  const caret = layout.caretRect(options.cursor, cursorStyle, options.overwriteMode ? graphemeWidth(overwriteText ?? " ") : 1);
  const cursorScreen = logicalToScreen({ x: caret.x1, y: caret.y1 }, options.camera, viewport);
  const cursorHeight = (caret.y2 - caret.y1) * metrics.height;
  if (shouldDrawCursor(options) && caret.x2 >= visible.x1 && caret.x1 <= visible.x2 && caret.y2 >= visible.y1 && caret.y1 <= visible.y2) {
    if (options.overwriteMode) {
      const width = (caret.x2 - caret.x1) * metrics.width;
      context.fillStyle = "rgba(82,97,230,0.2)";
      context.fillRect(cursorScreen.x, cursorScreen.y, width, cursorHeight);
      context.strokeStyle = "#5261e6";
      context.lineWidth = Math.max(1, 1.5 * options.camera.zoom);
      context.strokeRect(cursorScreen.x + 0.5, cursorScreen.y + 0.5, Math.max(0, width - 1), Math.max(0, cursorHeight - 1));
    } else {
      const inset = Math.min(cursorHeight / 4, Math.max(1, cursorHeight * 0.13));
      for (const [color, width] of [["rgba(247,247,244,0.94)", 4], ["#5261e6", 1.75]] as const) {
        context.strokeStyle = color;
        context.lineWidth = Math.max(width * 0.75, width * options.camera.zoom);
        context.beginPath();
        context.moveTo(cursorScreen.x, cursorScreen.y + inset);
        context.lineTo(cursorScreen.x, cursorScreen.y + cursorHeight - inset);
        context.stroke();
      }
    }
  }

  if (options.composition) {
    const scale = typingStyle.fontSize / BASE_FONT_SIZE;
    const rect = layout.caretRect(options.cursor, typingStyle);
    let x = rect.x1;
    for (const text of segmentGraphemes(options.composition)) {
      const width = graphemeWidth(text) * scale;
      const glyphRect = { ...rect, x1: x, x2: x + width };
      const screen = logicalToScreen({ x, y: rect.y1 }, options.camera, viewport);
      context.fillStyle = "rgba(224,227,255,0.96)";
      context.fillRect(screen.x, screen.y, width * metrics.width, scale * metrics.height);
      drawGlyph(context, { text, style: { ...typingStyle, underline: true }, rect: glyphRect }, options.camera, viewport, "#4753c8");
      x += width;
    }
  }

  if (options.searchLength > 0) {
    options.searchResults.forEach((result, index) => {
      const bounds = layout.searchRect(result, options.searchLength);
      drawSelection(context, bounds, options.camera, viewport, visible, "transparent",
        index === options.activeSearchIndex ? "#e89a3c" : "rgba(232,154,60,0.5)");
    });
  }
  drawBookmarks(context, options.bookmarks.map((b) => ({ ...b, ...layout.toWorld(b) })), options.camera, viewport, visible);
}

function fitBookmarkName(
  context: CanvasRenderingContext2D,
  name: string,
  maxWidth: number,
): string {
  if (context.measureText(name).width <= maxWidth) return name;
  const graphemes = segmentGraphemes(name);
  const ellipsis = "…";
  let low = 0;
  let high = graphemes.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${graphemes.slice(0, middle).join("")}${ellipsis}`;
    if (context.measureText(candidate).width <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return `${graphemes.slice(0, low).join("")}${ellipsis}`;
}

function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const right = x + width;
  const bottom = y + height;
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(right - radius, y);
  context.quadraticCurveTo(right, y, right, y + radius);
  context.lineTo(right, bottom - radius);
  context.quadraticCurveTo(right, bottom, right - radius, bottom);
  context.lineTo(x + radius, bottom);
  context.quadraticCurveTo(x, bottom, x, bottom - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function drawBookmarks(
  context: CanvasRenderingContext2D,
  bookmarks: Bookmark[],
  camera: Camera,
  viewport: Viewport,
  visible: Selection,
): void {
  const labelHeight = 22;
  const labelGap = 8;
  const labelPadding = 8;
  const maxLabelWidth = Math.min(220, Math.max(24, viewport.width - 12));

  context.save();
  context.font = `600 12px ${CANVAS_FONT_FAMILY}`;
  context.textAlign = "left";
  context.textBaseline = "middle";

  for (const bookmark of bookmarks) {
    if (
      bookmark.x < visible.x1 ||
      bookmark.x > visible.x2 ||
      bookmark.y < visible.y1 ||
      bookmark.y > visible.y2
    ) {
      continue;
    }

    const anchor = logicalToScreen(bookmark, camera, viewport);
    const displayName = fitBookmarkName(
      context,
      bookmark.name,
      maxLabelWidth - labelPadding * 2,
    );
    const labelWidth = Math.min(
      maxLabelWidth,
      Math.max(24, context.measureText(displayName).width + labelPadding * 2),
    );
    let labelX = anchor.x + labelGap;
    if (labelX + labelWidth > viewport.width - 6) {
      labelX = anchor.x - labelGap - labelWidth;
    }
    labelX = Math.min(
      Math.max(6, labelX),
      Math.max(6, viewport.width - labelWidth - 6),
    );
    let labelY = anchor.y - labelHeight - 7;
    if (labelY < 6) labelY = anchor.y + 7;
    labelY = Math.min(
      Math.max(6, labelY),
      Math.max(6, viewport.height - labelHeight - 6),
    );

    context.strokeStyle = "rgba(82, 97, 230, 0.72)";
    context.lineWidth = 1.25;
    context.beginPath();
    context.moveTo(anchor.x, anchor.y);
    context.lineTo(
      Math.min(Math.max(anchor.x, labelX), labelX + labelWidth),
      labelY < anchor.y ? labelY + labelHeight : labelY,
    );
    context.stroke();

    context.fillStyle = "rgba(82, 97, 230, 0.98)";
    context.beginPath();
    context.moveTo(anchor.x, anchor.y - 5);
    context.lineTo(anchor.x + 5, anchor.y);
    context.lineTo(anchor.x, anchor.y + 5);
    context.lineTo(anchor.x - 5, anchor.y);
    context.closePath();
    context.fill();
    context.strokeStyle = "rgba(255, 255, 255, 0.96)";
    context.lineWidth = 1.5;
    context.stroke();

    roundedRectPath(
      context,
      labelX,
      labelY,
      labelWidth,
      labelHeight,
      5,
    );
    context.fillStyle = "rgba(255, 255, 255, 0.96)";
    context.fill();
    context.strokeStyle = "rgba(82, 97, 230, 0.56)";
    context.lineWidth = 1;
    context.stroke();
    context.fillStyle = "#414fc9";
    context.fillText(
      displayName,
      labelX + labelPadding,
      labelY + labelHeight / 2 + 0.5,
    );
  }

  context.restore();
}

function drawSelection(
  context: CanvasRenderingContext2D,
  selection: Selection,
  camera: Camera,
  viewport: Viewport,
  visible: Selection,
  fill: string,
  stroke: string,
  resizable = false,
): void {
  const clipped = {
    x1: Math.max(selection.x1, visible.x1),
    y1: Math.max(selection.y1, visible.y1),
    x2: Math.min(selection.x2, visible.x2),
    y2: Math.min(selection.y2, visible.y2),
  };
  if (clipped.x2 <= clipped.x1 || clipped.y2 <= clipped.y1) return;
  const metrics = cellMetrics(camera);
  const start = logicalToScreen(
    { x: clipped.x1, y: clipped.y1 },
    camera,
    viewport,
  );
  const width = (clipped.x2 - clipped.x1) * metrics.width;
  const height = (clipped.y2 - clipped.y1) * metrics.height;
  context.fillStyle = fill;
  context.fillRect(start.x, start.y, width, height);
  context.strokeStyle = stroke;
  context.lineWidth = 1;
  context.strokeRect(start.x + 0.5, start.y + 0.5, width - 1, height - 1);

  if (!resizable) return;
  const top = start.y;
  const bottom = start.y + height;
  const left = start.x;
  const right = start.x + width;
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const handleHeight = Math.min(22, Math.max(10, height * 0.55));
  const handleWidth = Math.min(22, Math.max(10, width * 0.55));
  const edgeXs: number[] = [];
  if (selection.x1 >= visible.x1 && selection.x1 <= visible.x2) {
    edgeXs.push(logicalToScreen(
      { x: selection.x1, y: clipped.y1 },
      camera,
      viewport,
    ).x);
  }
  if (selection.x2 >= visible.x1 && selection.x2 <= visible.x2) {
    edgeXs.push(logicalToScreen(
      { x: selection.x2, y: clipped.y1 },
      camera,
      viewport,
    ).x);
  }
  for (const edgeX of edgeXs) {
    context.strokeStyle = "rgba(77, 91, 229, 0.92)";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(edgeX, top + 1);
    context.lineTo(edgeX, bottom - 1);
    context.stroke();
    context.fillStyle = "#ffffff";
    context.fillRect(edgeX - 2.5, centerY - handleHeight / 2, 5, handleHeight);
    context.strokeStyle = "#5261e6";
    context.lineWidth = 1;
    context.strokeRect(
      edgeX - 2,
      centerY - handleHeight / 2 + 0.5,
      4,
      handleHeight - 1,
    );
  }

  const edgeYs: number[] = [];
  if (selection.y1 >= visible.y1 && selection.y1 <= visible.y2) {
    edgeYs.push(logicalToScreen(
      { x: clipped.x1, y: selection.y1 },
      camera,
      viewport,
    ).y);
  }
  if (selection.y2 >= visible.y1 && selection.y2 <= visible.y2) {
    edgeYs.push(logicalToScreen(
      { x: clipped.x1, y: selection.y2 },
      camera,
      viewport,
    ).y);
  }
  for (const edgeY of edgeYs) {
    context.strokeStyle = "rgba(77, 91, 229, 0.92)";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(left + 1, edgeY);
    context.lineTo(right - 1, edgeY);
    context.stroke();
    context.fillStyle = "#ffffff";
    context.fillRect(centerX - handleWidth / 2, edgeY - 2.5, handleWidth, 5);
    context.strokeStyle = "#5261e6";
    context.lineWidth = 1;
    context.strokeRect(
      centerX - handleWidth / 2 + 0.5,
      edgeY - 2,
      handleWidth - 1,
      4,
    );
  }
}

export type MinimapTransform = {
  worldMinX: number;
  worldMinY: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  padding: number;
};

export const MIN_MINIMAP_ZOOM = 1;
export const MAX_MINIMAP_ZOOM = 16;

export function clampMinimapZoom(zoom: number): number {
  return Math.min(MAX_MINIMAP_ZOOM, Math.max(MIN_MINIMAP_ZOOM, zoom));
}

export function clampMinimapTarget(target: Position, bounds: Bounds): Position {
  return {
    x: Math.min(bounds.maxX - 1, Math.max(bounds.minX, target.x)),
    y: Math.min(bounds.maxY - 1, Math.max(bounds.minY, target.y)),
  };
}

const minimapCache = new WeakMap<HTMLCanvasElement, {
  document: SparseDocument;
  key: string;
  transform: MinimapTransform;
}>();

export function drawMinimap(
  canvas: HTMLCanvasElement,
  document: SparseDocument,
  camera: Camera,
  editorViewport: Viewport,
  minimapZoom = MIN_MINIMAP_ZOOM,
): MinimapTransform | null {
  const resized = resizeCanvas(canvas, 4);
  if (!resized) return null;
  const { context, viewport, dpr } = resized;
  // Cursor, selection and composition updates do not alter the minimap.
  // Canvas dimensions and DPR are included because resizing clears its pixels.
  const key = [document.contentRevision, viewport.width, viewport.height, dpr,
    camera.x, camera.y, camera.zoom, editorViewport.width, editorViewport.height,
    minimapZoom].join(",");
  const saved = minimapCache.get(canvas);
  if (saved?.document === document && saved.key === key) return saved.transform;
  context.clearRect(0, 0, viewport.width, viewport.height);

  const viewBounds = viewportCellBounds(camera, editorViewport);
  const layout = getTextLayout(document);
  const contentBounds = layout.bounds;
  let baseMinX = viewBounds.x1;
  let baseMinY = viewBounds.y1;
  let baseMaxX = viewBounds.x2;
  let baseMaxY = viewBounds.y2;
  if (contentBounds) {
    const contentWidth = Math.max(1, contentBounds.maxX - contentBounds.minX);
    const contentHeight = Math.max(1, contentBounds.maxY - contentBounds.minY);
    const margin = Math.min(
      64,
      Math.max(4, Math.ceil(Math.max(contentWidth, contentHeight) * 0.06)),
    );
    baseMinX = Math.min(viewBounds.x1, contentBounds.minX - margin);
    baseMinY = Math.min(viewBounds.y1, contentBounds.minY - margin);
    baseMaxX = Math.max(viewBounds.x2, contentBounds.maxX + margin);
    baseMaxY = Math.max(viewBounds.y2, contentBounds.maxY + margin);
  }


  const padding = 10;
  const worldWidth = Math.max(1, baseMaxX - baseMinX);
  const worldHeight = Math.max(1, baseMaxY - baseMinY);
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const zoom = clampMinimapZoom(minimapZoom);
  const scale = Math.min(
    availableWidth / worldWidth,
    availableHeight / worldHeight,
  ) * zoom;
  const visibleWorldWidth = availableWidth / scale;
  const visibleWorldHeight = availableHeight / scale;
  const contentCenterX = (baseMinX + baseMaxX) / 2;
  const contentCenterY = (baseMinY + baseMaxY) / 2;
  const minCenterX = baseMinX + visibleWorldWidth / 2;
  const maxCenterX = baseMaxX - visibleWorldWidth / 2;
  const minCenterY = baseMinY + visibleWorldHeight / 2;
  const maxCenterY = baseMaxY - visibleWorldHeight / 2;
  const focusX = minCenterX <= maxCenterX
    ? Math.min(maxCenterX, Math.max(minCenterX, camera.x))
    : contentCenterX;
  const focusY = minCenterY <= maxCenterY
    ? Math.min(maxCenterY, Math.max(minCenterY, camera.y))
    : contentCenterY;
  const worldMinX = focusX - visibleWorldWidth / 2;
  const worldMinY = focusY - visibleWorldHeight / 2;
  const worldMaxX = focusX + visibleWorldWidth / 2;
  const worldMaxY = focusY + visibleWorldHeight / 2;
  const offsetX = padding;
  const offsetY = padding;

  context.save();
  context.beginPath();
  context.rect(offsetX, offsetY, availableWidth, availableHeight);
  context.clip();

  const devicePixel = 1 / dpr;
  context.fillStyle = scale >= 1 ? "rgba(48,51,47,0.88)" : "rgba(48,51,47,0.72)";
  layout.forEachVisible({ x1: worldMinX, y1: worldMinY, x2: worldMaxX, y2: worldMaxY }, (glyph) => {
    const r = glyph.rect;
    const x = Math.round((offsetX + (r.x1 - worldMinX) * scale) * dpr) / dpr;
    const y = Math.round((offsetY + (r.y1 - worldMinY) * scale) * dpr) / dpr;
    context.fillRect(x, y, Math.max(devicePixel, (r.x2 - r.x1) * scale), Math.max(devicePixel, (r.y2 - r.y1) * scale));
  });

  const cameraX = offsetX + (viewBounds.x1 - worldMinX) * scale;
  const cameraY = offsetY + (viewBounds.y1 - worldMinY) * scale;
  const cameraWidth = Math.max(3, (viewBounds.x2 - viewBounds.x1) * scale);
  const cameraHeight = Math.max(3, (viewBounds.y2 - viewBounds.y1) * scale);
  context.fillStyle = "rgba(82, 97, 230, 0.08)";
  context.fillRect(cameraX, cameraY, cameraWidth, cameraHeight);
  context.strokeStyle = "rgba(82, 97, 230, 0.9)";
  context.lineWidth = 1.5;
  context.strokeRect(cameraX + 0.75, cameraY + 0.75, cameraWidth - 1.5, cameraHeight - 1.5);
  context.restore();

  const transform = { worldMinX, worldMinY, scale, offsetX, offsetY, padding };
  minimapCache.set(canvas, { document, key, transform });
  return transform;
}

export function minimapToWorld(
  x: number,
  y: number,
  transform: MinimapTransform,
): Position {
  return {
    x: transform.worldMinX + (x - transform.offsetX) / transform.scale,
    y: transform.worldMinY + (y - transform.offsetY) / transform.scale,
  };
}
