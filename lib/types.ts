export const CHUNK_SIZE = 64;
export const CHUNK_CELL_COUNT = CHUNK_SIZE * CHUNK_SIZE;
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;

const SELECTION_AUTO_PAN_EDGE_PX = 56;
const SELECTION_AUTO_PAN_SPEED_PX = 600;

export const MAX_TEXT_WIDTH = 100_000;
export const MAX_TEXT_HEIGHT = 100_000;
export const MAX_TEXT_CELLS = 1_000_000;
export const MAX_BOOKMARKS = 1_000;
export const MAX_BOOKMARK_NAME_LENGTH = 120;
export const MAX_BOOKMARK_ID_LENGTH = 128;

export type Position = {
  x: number;
  y: number;
};

export type Camera = {
  x: number;
  y: number;
  zoom: number;
};

export type Selection = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type Bookmark = {
  id: string;
  name: string;
  x: number;
  y: number;
};

export type Change = {
  x: number;
  y: number;
  before: string | null;
  after: string | null;
};

export type EditorSnapshot = {
  cursor: Position;
  selection: Selection | null;
  selectionReflow: SelectionReflow | null;
};

export type SelectionReflowLine = {
  readonly cells: ReadonlyArray<string | null>;
  readonly lineStartX: number;
};

export type SelectionReflow = {
  readonly lines: ReadonlyArray<SelectionReflowLine>;
};

export type HistoryBatch = {
  changes: Change[];
  before: EditorSnapshot;
  after: EditorSnapshot;
};

export type SearchResult = Position;

export type Bounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export class EditorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditorError";
  }
}

export function isSafePosition(position: Position): boolean {
  return Number.isSafeInteger(position.x) && Number.isSafeInteger(position.y);
}

export function assertSafePosition(position: Position): void {
  if (!isSafePosition(position)) {
    throw new EditorError("좌표가 안전한 정수 범위를 벗어났습니다.");
  }
}

export function safeAdd(value: number, delta: number): number {
  const result = value + delta;
  if (!Number.isSafeInteger(result)) {
    throw new EditorError("좌표가 안전한 정수 범위를 벗어났습니다.");
  }
  return result;
}

export function normalizeSelection(selection: Selection): Selection {
  return {
    x1: Math.min(selection.x1, selection.x2),
    y1: Math.min(selection.y1, selection.y2),
    x2: Math.max(selection.x1, selection.x2),
    y2: Math.max(selection.y1, selection.y2),
  };
}

export function selectionFromCursorDrag(
  anchor: Position,
  focus: Position,
): Selection | null {
  assertSafePosition(anchor);
  assertSafePosition(focus);
  if (anchor.x === focus.x && anchor.y === focus.y) return null;

  const x1 = Math.min(anchor.x, focus.x);
  const maxX = Math.max(anchor.x, focus.x);
  const maxY = Math.max(anchor.y, focus.y);
  if (
    maxY === Number.MAX_SAFE_INTEGER ||
    (x1 === maxX && maxX === Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }

  return {
    x1,
    y1: Math.min(anchor.y, focus.y),
    x2: x1 === maxX ? maxX + 1 : maxX,
    y2: maxY + 1,
  };
}

export function selectionAutoPanVelocity(
  pointerCoordinate: number,
  viewportSize: number,
): number {
  if (!Number.isFinite(pointerCoordinate) || viewportSize <= 0) return 0;
  const edgeSize = Math.max(
    1,
    Math.min(SELECTION_AUTO_PAN_EDGE_PX, viewportSize / 2),
  );
  if (pointerCoordinate < edgeSize) {
    const intensity = Math.min(
      1.5,
      (edgeSize - pointerCoordinate) / edgeSize,
    );
    return -SELECTION_AUTO_PAN_SPEED_PX * intensity;
  }
  if (pointerCoordinate > viewportSize - edgeSize) {
    const intensity = Math.min(
      1.5,
      (pointerCoordinate - (viewportSize - edgeSize)) / edgeSize,
    );
    return SELECTION_AUTO_PAN_SPEED_PX * intensity;
  }
  return 0;
}

export function cloneSelection(selection: Selection | null): Selection | null {
  return selection ? { ...selection } : null;
}

export function isPointInSelection(
  position: Position,
  selection: Selection | null,
): boolean {
  if (!selection) return false;
  return (
    position.x >= selection.x1 &&
    position.x < selection.x2 &&
    position.y >= selection.y1 &&
    position.y < selection.y2
  );
}

export function assertTextRasterSize(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 0 ||
    height < 0 ||
    width > MAX_TEXT_WIDTH ||
    height > MAX_TEXT_HEIGHT ||
    (height > 0 && width > Math.floor(MAX_TEXT_CELLS / height))
  ) {
    throw new EditorError(
      "텍스트 영역이 변환 한도(너비·높이 100,000, 총 1,000,000셀)를 넘습니다.",
    );
  }
}
