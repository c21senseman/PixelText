import { parseChunkKey, SparseDocument } from "./document";
import { segmentGraphemes } from "./graphemes";
import {
  Bookmark,
  Bounds,
  Camera,
  CHUNK_SIZE,
  Position,
  SearchResult,
  Selection,
} from "./types";

export const BASE_CELL_WIDTH = 20;
export const BASE_CELL_HEIGHT = 24;
const BASE_FONT_SIZE = 19;
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
): Position {
  const metrics = cellMetrics(camera);
  return {
    x: Math.floor(camera.x + (screenX - viewport.width / 2) / metrics.width),
    y: Math.floor(camera.y + (screenY - viewport.height / 2) / metrics.height),
  };
}

export function logicalToScreen(
  position: Position,
  camera: Camera,
  viewport: Viewport,
): Position {
  const metrics = cellMetrics(camera);
  return {
    x: (position.x - camera.x) * metrics.width + viewport.width / 2,
    y: (position.y - camera.y) * metrics.height + viewport.height / 2,
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

export function drawEditorCanvas(
  canvas: HTMLCanvasElement,
  options: DrawEditorOptions,
): void {
  const resized = resizeCanvas(canvas);
  if (!resized) return;
  const { context, viewport } = resized;
  const metrics = cellMetrics(options.camera);
  const visible = viewportCellBounds(options.camera, viewport);

  context.clearRect(0, 0, viewport.width, viewport.height);
  context.fillStyle = "#f7f7f4";
  context.fillRect(0, 0, viewport.width, viewport.height);

  context.font = `${Math.max(4, BASE_FONT_SIZE * options.camera.zoom)}px ${CANVAS_FONT_FAMILY}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#252521";

  options.document.forEachInRect(
    visible.x1,
    visible.y1,
    visible.x2,
    visible.y2,
    (x, y, value) => {
      const screen = logicalToScreen({ x, y }, options.camera, viewport);
      context.save();
      context.beginPath();
      context.rect(screen.x, screen.y, metrics.width, metrics.height);
      context.clip();
      context.fillText(
        value,
        screen.x + metrics.width / 2,
        screen.y + metrics.height * 0.53,
        metrics.width * 0.96,
      );
      context.restore();
    },
  );

  if (options.selection) {
    const preview = options.selectionPreview ?? { dx: 0, dy: 0 };
    if (options.selectionPreview || options.selectionResizePreview) {
      drawSelection(
        context,
        options.selection,
        options.camera,
        viewport,
        visible,
        "rgba(57, 70, 61, 0.06)",
        "rgba(57, 70, 61, 0.24)",
      );
    }
    drawSelection(
      context,
      options.selectionResizePreview ?? {
          x1: options.selection.x1 + preview.dx,
          y1: options.selection.y1 + preview.dy,
          x2: options.selection.x2 + preview.dx,
          y2: options.selection.y2 + preview.dy,
        },
      options.camera,
      viewport,
      visible,
      "rgba(92, 105, 246, 0.16)",
      "rgba(77, 91, 229, 0.7)",
      true,
    );
  }

  const cursorScreen = logicalToScreen(options.cursor, options.camera, viewport);
  if (
    shouldDrawCursor(options) &&
    options.cursor.x >= visible.x1 &&
    options.cursor.x <= visible.x2 &&
    options.cursor.y >= visible.y1 &&
    options.cursor.y <= visible.y2
  ) {
    if (options.overwriteMode) {
      const lineWidth = Math.max(1, 1.5 * options.camera.zoom);
      context.fillStyle = "rgba(82, 97, 230, 0.2)";
      context.fillRect(
        cursorScreen.x,
        cursorScreen.y,
        metrics.width,
        metrics.height,
      );
      context.strokeStyle = "#5261e6";
      context.lineWidth = lineWidth;
      context.strokeRect(
        cursorScreen.x + lineWidth / 2,
        cursorScreen.y + lineWidth / 2,
        Math.max(0, metrics.width - lineWidth),
        Math.max(0, metrics.height - lineWidth),
      );
    } else {
      const inset = Math.max(2, metrics.height * 0.13);
      context.strokeStyle = "rgba(247, 247, 244, 0.94)";
      context.lineWidth = Math.max(3, 4 * options.camera.zoom);
      context.beginPath();
      context.moveTo(cursorScreen.x, cursorScreen.y + inset);
      context.lineTo(cursorScreen.x, cursorScreen.y + metrics.height - inset);
      context.stroke();
      context.strokeStyle = "#5261e6";
      context.lineWidth = Math.max(1.5, 1.75 * options.camera.zoom);
      context.beginPath();
      context.moveTo(cursorScreen.x, cursorScreen.y + inset);
      context.lineTo(cursorScreen.x, cursorScreen.y + metrics.height - inset);
      context.stroke();
    }
  }

  if (options.composition) {
    const graphemes = segmentGraphemes(options.composition);
    context.font = `${Math.max(4, BASE_FONT_SIZE * options.camera.zoom)}px ${CANVAS_FONT_FAMILY}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    for (let index = 0; index < graphemes.length; index += 1) {
      const position = { x: options.cursor.x + index, y: options.cursor.y };
      const screen = logicalToScreen(position, options.camera, viewport);
      context.fillStyle = options.overwriteMode
        ? "rgba(224, 227, 255, 0.96)"
        : "rgba(82, 97, 230, 0.08)";
      context.fillRect(screen.x, screen.y, metrics.width, metrics.height);
      context.save();
      context.beginPath();
      context.rect(screen.x, screen.y, metrics.width, metrics.height);
      context.clip();
      context.fillStyle = "#4753c8";
      context.fillText(
        graphemes[index],
        screen.x + metrics.width / 2,
        screen.y + metrics.height * 0.53,
        metrics.width * 0.96,
      );
      context.restore();
      context.strokeStyle = "#5261e6";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(screen.x + 2, screen.y + metrics.height - 2);
      context.lineTo(screen.x + metrics.width - 2, screen.y + metrics.height - 2);
      context.stroke();
    }
  }

  if (options.searchLength > 0) {
    const visibleResults = options.searchResults;
    for (let index = 0; index < visibleResults.length; index += 1) {
      const result = visibleResults[index];
      if (
        result.x + options.searchLength < visible.x1 ||
        result.x > visible.x2 ||
        result.y < visible.y1 ||
        result.y > visible.y2
      ) {
        continue;
      }
      const screen = logicalToScreen(result, options.camera, viewport);
      context.strokeStyle =
        index === options.activeSearchIndex ? "#e89a3c" : "rgba(232, 154, 60, 0.5)";
      context.lineWidth = index === options.activeSearchIndex ? 2 : 1;
      context.strokeRect(
        screen.x + 1,
        screen.y + 1,
        metrics.width * options.searchLength - 2,
        metrics.height - 2,
      );
    }
  }

  drawBookmarks(
    context,
    options.bookmarks,
    options.camera,
    viewport,
    visible,
  );
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
  worldMaxX: number;
  worldMaxY: number;
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

export function minimapBaseBounds(
  contentBounds: Bounds | null,
  viewBounds: Selection,
): Bounds {
  if (!contentBounds) {
    return {
      minX: viewBounds.x1,
      minY: viewBounds.y1,
      maxX: viewBounds.x2,
      maxY: viewBounds.y2,
    };
  }

  const contentWidth = Math.max(1, contentBounds.maxX - contentBounds.minX);
  const contentHeight = Math.max(1, contentBounds.maxY - contentBounds.minY);
  const margin = Math.min(
    64,
    Math.max(4, Math.ceil(Math.max(contentWidth, contentHeight) * 0.06)),
  );
  return {
    minX: contentBounds.minX - margin,
    minY: contentBounds.minY - margin,
    maxX: contentBounds.maxX + margin,
    maxY: contentBounds.maxY + margin,
  };
}

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
  context.clearRect(0, 0, viewport.width, viewport.height);

  const viewBounds = viewportCellBounds(camera, editorViewport);
  const baseBounds = minimapBaseBounds(document.bounds(), viewBounds);
  const baseMinX = baseBounds.minX;
  const baseMinY = baseBounds.minY;
  const baseMaxX = baseBounds.maxX;
  const baseMaxY = baseBounds.maxY;

  const chunkKeys = document.chunkKeys();

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
  for (const key of chunkKeys) {
    const coordinates = parseChunkKey(key);
    const chunk = document.getChunk(key);
    if (!chunk) continue;
    const chunkWorldX = coordinates.x * CHUNK_SIZE;
    const chunkWorldY = coordinates.y * CHUNK_SIZE;
    if (
      chunkWorldX + CHUNK_SIZE <= worldMinX ||
      chunkWorldX >= worldMaxX ||
      chunkWorldY + CHUNK_SIZE <= worldMinY ||
      chunkWorldY >= worldMaxY
    ) {
      continue;
    }
    const chunkX = offsetX + (chunkWorldX - worldMinX) * scale;
    const chunkY = offsetY + (chunkWorldY - worldMinY) * scale;
    const chunkScreenSize = CHUNK_SIZE * scale;

    if (chunkScreenSize >= 4) {
      const cellSize = Math.max(devicePixel, scale);
      context.fillStyle = scale >= 1 ? "rgba(48, 51, 47, 0.88)" : "rgba(48, 51, 47, 0.72)";
      for (const index of chunk.keys()) {
        const lx = index % CHUNK_SIZE;
        const ly = Math.floor(index / CHUNK_SIZE);
        const x = Math.round((chunkX + lx * scale) * dpr) / dpr;
        const y = Math.round((chunkY + ly * scale) * dpr) / dpr;
        context.fillRect(x, y, cellSize, cellSize);
      }
    } else {
      const density = chunk.size / (CHUNK_SIZE * CHUNK_SIZE);
      const x = Math.round(chunkX * dpr) / dpr;
      const y = Math.round(chunkY * dpr) / dpr;
      const size = Math.max(devicePixel, chunkScreenSize);
      context.fillStyle = `rgba(48, 51, 47, ${Math.min(0.9, 0.5 + Math.sqrt(density) * 1.2)})`;
      context.fillRect(x, y, size, size);
    }
  }

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

  return {
    worldMinX,
    worldMinY,
    worldMaxX,
    worldMaxY,
    scale,
    offsetX,
    offsetY,
    padding,
  };
}

export function minimapToWorld(
  x: number,
  y: number,
  transform: MinimapTransform,
): Position {
  return {
    x: Math.min(
      transform.worldMaxX,
      Math.max(
        transform.worldMinX,
        transform.worldMinX + (x - transform.offsetX) / transform.scale,
      ),
    ),
    y: Math.min(
      transform.worldMaxY,
      Math.max(
        transform.worldMinY,
        transform.worldMinY + (y - transform.offsetY) / transform.scale,
      ),
    ),
  };
}
