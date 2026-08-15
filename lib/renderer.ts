import { parseChunkKey, SparseDocument } from "./document";
import { segmentGraphemes } from "./graphemes";
import {
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
  camera: Camera;
  cursor: Position;
  selection: Selection | null;
  composition: string;
  searchResults: SearchResult[];
  activeSearchIndex: number;
  searchLength: number;
  selectionPreview?: SelectionPreview | null;
  selectionResizePreview?: Selection | null;
};

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
    options.cursor.x >= visible.x1 &&
    options.cursor.x <= visible.x2 &&
    options.cursor.y >= visible.y1 &&
    options.cursor.y <= visible.y2
  ) {
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

  if (options.composition) {
    const graphemes = segmentGraphemes(options.composition);
    context.font = `${Math.max(4, BASE_FONT_SIZE * options.camera.zoom)}px ${CANVAS_FONT_FAMILY}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    for (let index = 0; index < graphemes.length; index += 1) {
      const position = { x: options.cursor.x + index, y: options.cursor.y };
      const screen = logicalToScreen(position, options.camera, viewport);
      context.fillStyle = "rgba(82, 97, 230, 0.08)";
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
  const centerY = (top + bottom) / 2;
  const handleHeight = Math.min(22, Math.max(10, height * 0.55));
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
  const contentBounds = document.bounds();
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
    baseMinX = contentBounds.minX - margin;
    baseMinY = contentBounds.minY - margin;
    baseMaxX = contentBounds.maxX + margin;
    baseMaxY = contentBounds.maxY + margin;
  }

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

  return { worldMinX, worldMinY, scale, offsetX, offsetY, padding };
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
