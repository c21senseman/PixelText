import { SerializedChunk, SparseDocument } from "./document";
import { hasControlCharacter, isValidCellValue } from "./graphemes";
import {
  Bookmark,
  Camera,
  CHUNK_CELL_COUNT,
  CHUNK_SIZE,
  EditorError,
  MAX_BOOKMARK_ID_LENGTH,
  MAX_BOOKMARK_NAME_LENGTH,
  MAX_BOOKMARKS,
  MAX_TEXT_CELLS,
  MAX_ZOOM,
  MIN_ZOOM,
  assertSafePosition,
  assertTextRasterSize,
} from "./types";

export const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMPORT_CHUNKS = 50_000;

export type PixelTextFile = {
  version: 1;
  chunkSize: 64;
  chunks: SerializedChunk[];
  bookmarks: Bookmark[];
  camera: Camera;
};

export type ImportedDocument = {
  document: SparseDocument;
  bookmarks: Bookmark[];
  camera: Camera;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRequiredFields(
  value: Record<string, unknown>,
  fields: string[],
): boolean {
  return fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

export function assertImportFileSize(size: number): void {
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_IMPORT_FILE_BYTES
  ) {
    throw new EditorError("가져올 JSON 파일은 20 MiB 이하여야 합니다.");
  }
}

export function parseBookmarks(value: unknown): Bookmark[] {
  if (!Array.isArray(value)) {
    throw new EditorError("bookmarks는 배열이어야 합니다.");
  }
  if (value.length > MAX_BOOKMARKS) {
    throw new EditorError(
      `책갈피는 최대 ${MAX_BOOKMARKS.toLocaleString()}개까지 가져올 수 있습니다.`,
    );
  }

  const bookmarkIds = new Set<string>();
  const bookmarks: Bookmark[] = [];
  for (const rawBookmark of value) {
    if (
      !isRecord(rawBookmark) ||
      typeof rawBookmark.id !== "string" ||
      rawBookmark.id.length === 0 ||
      rawBookmark.id.length > MAX_BOOKMARK_ID_LENGTH ||
      hasControlCharacter(rawBookmark.id) ||
      bookmarkIds.has(rawBookmark.id) ||
      typeof rawBookmark.name !== "string" ||
      rawBookmark.name.trim().length === 0 ||
      rawBookmark.name.length > MAX_BOOKMARK_NAME_LENGTH ||
      hasControlCharacter(rawBookmark.name) ||
      !Number.isSafeInteger(rawBookmark.x) ||
      !Number.isSafeInteger(rawBookmark.y)
    ) {
      throw new EditorError("잘못되거나 중복된 책갈피가 있습니다.");
    }
    bookmarkIds.add(rawBookmark.id);
    bookmarks.push({
      id: rawBookmark.id,
      name: rawBookmark.name,
      x: rawBookmark.x as number,
      y: rawBookmark.y as number,
    });
  }
  return bookmarks;
}

export function exportJson(
  document: SparseDocument,
  bookmarks: Bookmark[],
  camera: Camera,
): string {
  const file: PixelTextFile = {
    version: 1,
    chunkSize: CHUNK_SIZE,
    chunks: document.sortedChunks(),
    bookmarks: bookmarks.map((bookmark) => ({ ...bookmark })),
    camera: { ...camera },
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function importJson(raw: string): ImportedDocument {
  assertImportFileSize(raw.length);
  assertImportFileSize(new TextEncoder().encode(raw).byteLength);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EditorError("올바른 JSON 파일이 아닙니다.");
  }
  if (
    !isRecord(parsed) ||
    !hasRequiredFields(parsed, [
      "version",
      "chunkSize",
      "chunks",
      "bookmarks",
      "camera",
    ])
  ) {
    throw new EditorError("필수 문서 필드가 없습니다.");
  }
  if (parsed.version !== 1 || parsed.chunkSize !== CHUNK_SIZE) {
    throw new EditorError("지원하지 않는 문서 버전 또는 청크 크기입니다.");
  }
  if (!Array.isArray(parsed.chunks)) {
    throw new EditorError("chunks는 배열이어야 합니다.");
  }
  if (parsed.chunks.length > MAX_IMPORT_CHUNKS) {
    throw new EditorError(
      `청크는 최대 ${MAX_IMPORT_CHUNKS.toLocaleString()}개까지 가져올 수 있습니다.`,
    );
  }

  const chunks: SerializedChunk[] = [];
  const chunkKeys = new Set<string>();
  let importedCellCount = 0;
  for (const rawChunk of parsed.chunks) {
    if (
      !isRecord(rawChunk) ||
      !Number.isSafeInteger(rawChunk.x) ||
      !Number.isSafeInteger(rawChunk.y) ||
      !Array.isArray(rawChunk.cells)
    ) {
      throw new EditorError("잘못된 청크가 있습니다.");
    }
    importedCellCount += rawChunk.cells.length;
    if (importedCellCount > MAX_TEXT_CELLS) {
      throw new EditorError(
        `저장 셀은 최대 ${MAX_TEXT_CELLS.toLocaleString()}개까지 가져올 수 있습니다.`,
      );
    }
    const key = `${rawChunk.x},${rawChunk.y}`;
    if (chunkKeys.has(key)) throw new EditorError("중복된 청크 좌표가 있습니다.");
    chunkKeys.add(key);
    const seenIndices = new Set<number>();
    const cells: Array<[number, string]> = [];
    for (const rawCell of rawChunk.cells) {
      if (
        !Array.isArray(rawCell) ||
        rawCell.length !== 2 ||
        !Number.isInteger(rawCell[0]) ||
        rawCell[0] < 0 ||
        rawCell[0] >= CHUNK_CELL_COUNT ||
        seenIndices.has(rawCell[0]) ||
        !isValidCellValue(rawCell[1])
      ) {
        throw new EditorError("잘못되거나 중복된 셀 데이터가 있습니다.");
      }
      seenIndices.add(rawCell[0]);
      cells.push([rawCell[0], rawCell[1]]);
    }
    chunks.push({
      x: rawChunk.x as number,
      y: rawChunk.y as number,
      cells,
    });
  }

  const bookmarks = parseBookmarks(parsed.bookmarks);

  if (!isRecord(parsed.camera)) {
    throw new EditorError("camera가 올바르지 않습니다.");
  }
  const camera = {
    x: parsed.camera.x,
    y: parsed.camera.y,
    zoom: parsed.camera.zoom,
  };
  if (
    typeof camera.x !== "number" ||
    typeof camera.y !== "number" ||
    typeof camera.zoom !== "number" ||
    !Number.isFinite(camera.x) ||
    !Number.isFinite(camera.y) ||
    !Number.isFinite(camera.zoom) ||
    camera.zoom < MIN_ZOOM ||
    camera.zoom > MAX_ZOOM
  ) {
    throw new EditorError("카메라 값이 허용 범위를 벗어났습니다.");
  }

  const document = SparseDocument.fromChunks(chunks);
  for (const bookmark of bookmarks) assertSafePosition(bookmark);
  return { document, bookmarks, camera: camera as Camera };
}

export function exportTxt(document: SparseDocument): string {
  const bounds = document.bounds();
  if (!bounds) return "";
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  assertTextRasterSize(width, height);
  const lines: string[] = [];
  for (let y = bounds.minY; y < bounds.maxY; y += 1) {
    let line = "";
    for (let x = bounds.minX; x < bounds.maxX; x += 1) {
      line += document.getCell(x, y) ?? " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
