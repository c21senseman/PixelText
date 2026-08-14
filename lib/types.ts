export const CHUNK_SIZE = 64;
export const CHUNK_CELL_COUNT = CHUNK_SIZE * CHUNK_SIZE;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;

export const MAX_TEXT_WIDTH = 100_000;
export const MAX_TEXT_HEIGHT = 100_000;
export const MAX_TEXT_CELLS = 1_000_000;

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

