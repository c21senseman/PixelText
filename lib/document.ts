import {
  Bounds,
  CHUNK_CELL_COUNT,
  CHUNK_SIZE,
  EditorError,
  Position,
  Selection,
  assertSafePosition,
  selectionRowRange,
} from "./types";
import { assertValidCellValue, graphemeWidth } from "./graphemes";
import { DEFAULT_TEXT_STYLE, parseTextStyle, sameStyle, type TextStyle, type StyledCell } from "./formatting";

export type ChunkKey = `${number},${number}`;
export type Chunk = Map<number, string>;

export type SerializedChunk = {
  x: number;
  y: number;
  cells: Array<[number, string]>;
  styles?: Array<[number, TextStyle]>;
};

export function chunkAddress(position: Position): {
  cx: number;
  cy: number;
  lx: number;
  ly: number;
  index: number;
  key: ChunkKey;
} {
  assertSafePosition(position);
  const cx = Math.floor(position.x / CHUNK_SIZE);
  const cy = Math.floor(position.y / CHUNK_SIZE);
  const lx = position.x - cx * CHUNK_SIZE;
  const ly = position.y - cy * CHUNK_SIZE;
  return {
    cx,
    cy,
    lx,
    ly,
    index: ly * CHUNK_SIZE + lx,
    key: `${cx},${cy}`,
  };
}

export function parseChunkKey(key: string): { x: number; y: number } {
  const comma = key.indexOf(",");
  return {
    x: Number(key.slice(0, comma)),
    y: Number(key.slice(comma + 1)),
  };
}

export class SparseDocument {
  private readonly chunks = new Map<ChunkKey, Chunk>();
  private readonly styles = new Map<ChunkKey, Map<number, TextStyle>>();
  private readonly rowIndex = new Map<number, { revision: number; chunks: Set<ChunkKey> }>();
  private readonly dirtyRevisions = new Map<ChunkKey, number>();
  private revision = 0;
  private storedCellCountValue = 0;
  private interCharacterSpaceCountValue = 0;

  get contentRevision(): number { return this.revision; }

  rowKeys(): IterableIterator<number> { return this.rowIndex.keys(); }
  rowRevision(y: number): number { return this.rowIndex.get(y)?.revision ?? 0; }

  *entriesInRow(y: number): Generator<[Position, string]> {
    const row = this.rowIndex.get(y);
    if (!row) return;
    const ly = y - Math.floor(y / CHUNK_SIZE) * CHUNK_SIZE;
    for (const key of row.chunks) {
      const chunk = this.chunks.get(key);
      if (!chunk) continue;
      const startX = parseChunkKey(key).x * CHUNK_SIZE;
      for (let lx = 0; lx < CHUNK_SIZE; lx += 1) {
        const text = chunk.get(ly * CHUNK_SIZE + lx);
        if (text !== undefined) yield [{ x: startX + lx, y }, text];
      }
    }
  }

  private touchRow(y: number, key: ChunkKey, hasCell = true): void {
    const row = this.rowIndex.get(y) ?? { revision: this.revision, chunks: new Set<ChunkKey>() };
    if (!hasCell) {
      const chunk = this.chunks.get(key);
      const ly = y - Math.floor(y / CHUNK_SIZE) * CHUNK_SIZE;
      for (let lx = 0; chunk && lx < CHUNK_SIZE; lx += 1) {
        if (chunk.has(ly * CHUNK_SIZE + lx)) { hasCell = true; break; }
      }
    }
    if (hasCell) row.chunks.add(key);
    else row.chunks.delete(key);
    row.revision = this.revision;
    if (row.chunks.size) this.rowIndex.set(y, row);
    else this.rowIndex.delete(y);
  }

  getStyle(x: number, y: number): TextStyle {
    const { key, index } = chunkAddress({ x, y });
    return this.styles.get(key)?.get(index) ?? DEFAULT_TEXT_STYLE;
  }

  getStyledCell(x: number, y: number): StyledCell | null {
    const text = this.getCell(x, y);
    return text === null ? null : { text, style: this.getStyle(x, y) };
  }

  setStyle(x: number, y: number, style: TextStyle): void {
    const next = parseTextStyle(style);
    if (this.getCell(x, y) === null || sameStyle(this.getStyle(x, y), next)) return;
    const { key, index } = chunkAddress({ x, y });
    if (sameStyle(next, DEFAULT_TEXT_STYLE)) {
      this.styles.get(key)?.delete(index);
      if (this.styles.get(key)?.size === 0) this.styles.delete(key);
    } else {
      const chunk = this.styles.get(key) ?? new Map<number, TextStyle>();
      chunk.set(index, next);
      this.styles.set(key, chunk);
    }
    this.markDirty(key);
    this.touchRow(y, key);
  }

  get cellCount(): number {
    return this.storedCellCountValue + this.interCharacterSpaceCountValue;
  }

  get storedCellCount(): number {
    return this.storedCellCountValue;
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  getCell(x: number, y: number): string | null {
    const { key, index } = chunkAddress({ x, y });
    return this.chunks.get(key)?.get(index) ?? null;
  }

  // Only anchors are stored; the empty string represents the second occupied column.
  getRasterCell(x: number, y: number): string | null {
    const value = this.getCell(x, y);
    if (value !== null) return value;
    if (x > Number.MIN_SAFE_INTEGER) {
      const left = this.getCell(x - 1, y);
      if (left !== null && graphemeWidth(left) === 2) return "";
    }
    return null;
  }

  snapPosition(position: Position): Position {
    return this.getRasterCell(position.x, position.y) === ""
      ? { x: position.x - 1, y: position.y }
      : { ...position };
  }

  isInterCharacterSpace(x: number, y: number): boolean {
    assertSafePosition({ x, y });
    return (
      this.getRasterCell(x, y) === null &&
      x > Number.MIN_SAFE_INTEGER &&
      x < Number.MAX_SAFE_INTEGER &&
      this.getRasterCell(x - 1, y) !== null &&
      this.getCell(x + 1, y) !== null
    );
  }

  getTextCell(x: number, y: number): string | null {
    return this.getCell(x, y) ?? (this.isInterCharacterSpace(x, y) ? " " : null);
  }

  private spaceCandidates(x: number): number[] {
    const candidates = [x];
    if (x < Number.MAX_SAFE_INTEGER - 1) candidates.push(x + 2);
    if (x > Number.MIN_SAFE_INTEGER) candidates.push(x - 1);
    if (x < Number.MAX_SAFE_INTEGER) candidates.push(x + 1);
    return candidates;
  }

  private countInterCharacterSpaces(xs: Iterable<number>, y: number): number {
    let count = 0;
    for (const x of xs) {
      if (this.isInterCharacterSpace(x, y)) count += 1;
    }
    return count;
  }

  setCell(x: number, y: number, value: string | null, style = DEFAULT_TEXT_STYLE): void {
    assertSafePosition({ x, y });
    style = parseTextStyle(style);
    if (value !== null) {
      assertValidCellValue(value);
      assertSafePosition({ x: x + (graphemeWidth(value) - 1), y });
    }
    const nextValue = value === " " ? null : value;

    const { key, index } = chunkAddress({ x, y });
    const chunk = this.chunks.get(key);
    const before = chunk?.get(index) ?? null;
    if (before === nextValue) {
      if (nextValue !== null) this.setStyle(x, y, style);
      return;
    }
    const spaceCandidates = this.spaceCandidates(x);
    const spacesBefore = this.countInterCharacterSpaces(spaceCandidates, y);

    if (nextValue === null) {
      if (!chunk) return;
      chunk.delete(index);
      this.styles.get(key)?.delete(index);
      if (this.styles.get(key)?.size === 0) this.styles.delete(key);
      this.storedCellCountValue -= 1;
      if (chunk.size === 0) this.chunks.delete(key);
    } else {
      const target = chunk ?? new Map<number, string>();
      if (!chunk) this.chunks.set(key, target);
      if (before === null) this.storedCellCountValue += 1;
      target.set(index, nextValue);
      this.setStyle(x, y, style);
    }

    const spacesAfter = this.countInterCharacterSpaces(spaceCandidates, y);
    this.interCharacterSpaceCountValue += spacesAfter - spacesBefore;

    this.markDirty(key);
    this.touchRow(y, key, nextValue !== null);
  }

  deleteCell(x: number, y: number): void {
    this.setCell(x, y, null);
  }

  private markDirty(key: ChunkKey): void {
    this.revision += 1;
    this.dirtyRevisions.set(key, this.revision);
  }

  markAllDirty(extraDeletedKeys: Iterable<string> = []): void {
    for (const key of this.chunks.keys()) this.markDirty(key);
    for (const key of extraDeletedKeys) this.markDirty(key as ChunkKey);
  }

  dirtySnapshot(): Map<ChunkKey, number> {
    return new Map(this.dirtyRevisions);
  }

  markSaved(snapshot: Map<ChunkKey, number>): void {
    for (const [key, savedRevision] of snapshot) {
      if (this.dirtyRevisions.get(key) === savedRevision) {
        this.dirtyRevisions.delete(key);
      }
    }
  }

  get isDirty(): boolean {
    return this.dirtyRevisions.size > 0;
  }

  chunkKeys(): ChunkKey[] {
    return Array.from(this.chunks.keys());
  }

  getChunk(key: ChunkKey): ReadonlyMap<number, string> | null {
    return this.chunks.get(key) ?? null;
  }

  serializeChunk(key: ChunkKey): SerializedChunk | null {
    const chunk = this.chunks.get(key);
    if (!chunk || chunk.size === 0) return null;
    const coordinates = parseChunkKey(key);
    return {
      x: coordinates.x,
      y: coordinates.y,
      cells: Array.from(chunk.entries()).sort((a, b) => a[0] - b[0]),
      ...(this.styles.has(key) ? { styles: Array.from(this.styles.get(key)!.entries()).sort((a, b) => a[0] - b[0]) } : {}),
    };
  }

  sortedChunks(): SerializedChunk[] {
    return Array.from(this.chunks.keys())
      .map((key) => this.serializeChunk(key))
      .filter((chunk): chunk is SerializedChunk => chunk !== null)
      .sort((a, b) => a.y - b.y || a.x - b.x);
  }

  *entries(): Generator<[Position, string]> {
    for (const [key, chunk] of this.chunks) {
      const { x: cx, y: cy } = parseChunkKey(key);
      for (const [index, value] of chunk) {
        const lx = index % CHUNK_SIZE;
        const ly = Math.floor(index / CHUNK_SIZE);
        yield [{ x: cx * CHUNK_SIZE + lx, y: cy * CHUNK_SIZE + ly }, value];
      }
    }
  }

  forEachInRect(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    callback: (x: number, y: number, value: string) => void,
    fullyContained = false,
  ): void {
    if (maxX <= minX || maxY <= minY) return;
    const minCx = Math.floor((minX - 1) / CHUNK_SIZE);
    const maxCx = Math.floor((maxX - 1) / CHUNK_SIZE);
    const minCy = Math.floor(minY / CHUNK_SIZE);
    const maxCy = Math.floor((maxY - 1) / CHUNK_SIZE);

    for (let cy = minCy; cy <= maxCy; cy += 1) {
      for (let cx = minCx; cx <= maxCx; cx += 1) {
        const chunk = this.chunks.get(`${cx},${cy}`);
        if (!chunk) continue;
        for (const [index, value] of chunk) {
          const x = cx * CHUNK_SIZE + (index % CHUNK_SIZE);
          const y = cy * CHUNK_SIZE + Math.floor(index / CHUNK_SIZE);
          if (x + graphemeWidth(value) > minX && x < maxX && y >= minY && y < maxY) {
            if (!fullyContained || (x >= minX && x + graphemeWidth(value) <= maxX)) {
              callback(x, y, value);
            }
          }
        }
      }
    }
  }

  forEachInSelection(selection: Selection, callback: (x: number, y: number, value: string) => void, fullyContained = false): void {
    this.forEachInRect(selection.x1, selection.y1, selection.x2, selection.y2, (x, y, value) => {
      const range = selectionRowRange(selection, y);
      const end = x + graphemeWidth(value);
      if (end > range.x1 && x < range.x2 && (!fullyContained || (x >= range.x1 && end <= range.x2))) callback(x, y, value);
    }, fullyContained);
  }

  bounds(): Bounds | null {
    if (this.storedCellCountValue === 0) return null;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const [position, value] of this.entries()) {
      minX = Math.min(minX, position.x);
      minY = Math.min(minY, position.y);
      maxX = Math.max(maxX, position.x + graphemeWidth(value));
      maxY = Math.max(maxY, position.y + 1);
    }
    return { minX, minY, maxX, maxY };
  }

  cloneClean(): SparseDocument {
    const copy = new SparseDocument();
    for (const chunk of this.sortedChunks()) {
      copy.loadChunk(chunk);
    }
    return copy;
  }

  loadChunk(serialized: SerializedChunk): void {
    if (
      !Number.isSafeInteger(serialized.x) ||
      !Number.isSafeInteger(serialized.y)
    ) {
      throw new EditorError("청크 좌표가 안전한 정수 범위를 벗어났습니다.");
    }
    const key = `${serialized.x},${serialized.y}` as ChunkKey;
    if (this.chunks.has(key)) throw new EditorError("중복된 청크가 있습니다.");
    const chunk: Chunk = new Map();
    const styles = new Map<number, TextStyle>();
    if (serialized.styles !== undefined) {
      if (!Array.isArray(serialized.styles)) throw new EditorError("청크 서식은 배열이어야 합니다.");
      for (const entry of serialized.styles) {
        if (!Array.isArray(entry) || entry.length !== 2 || !Number.isInteger(entry[0]) || styles.has(entry[0])) {
          throw new EditorError("잘못되거나 중복된 글자 서식입니다.");
        }
        styles.set(entry[0], parseTextStyle(entry[1]));
      }
    }
    const seenIndices = new Set<number>();
    const spaceCandidatesByRow = new Map<number, Set<number>>();
    for (const [index, value] of serialized.cells) {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= CHUNK_CELL_COUNT ||
        seenIndices.has(index)
      ) {
        throw new EditorError("청크 안에 잘못되거나 중복된 셀 위치가 있습니다.");
      }
      seenIndices.add(index);
      assertValidCellValue(value);
      const lx = index % CHUNK_SIZE;
      const ly = Math.floor(index / CHUNK_SIZE);
      const x = serialized.x * CHUNK_SIZE + lx;
      const y = serialized.y * CHUNK_SIZE + ly;
      assertSafePosition({ x, y });
      assertSafePosition({ x: x + (graphemeWidth(value) - 1), y });
      if (value === " ") continue;
      chunk.set(index, value);
      const candidates = spaceCandidatesByRow.get(y) ?? new Set<number>();
      for (const candidate of this.spaceCandidates(x)) candidates.add(candidate);
      spaceCandidatesByRow.set(y, candidates);
    }
    for (const index of styles.keys()) {
      if (!chunk.has(index)) throw new EditorError("서식에 해당하는 문자가 없습니다.");
    }
    if (styles.size > 0) this.styles.set(key, styles);
    if (chunk.size > 0) {
      let spacesBefore = 0;
      for (const [y, candidates] of spaceCandidatesByRow) {
        spacesBefore += this.countInterCharacterSpaces(candidates, y);
      }
      this.chunks.set(key, chunk);
      this.storedCellCountValue += chunk.size;
      let spacesAfter = 0;
      for (const [y, candidates] of spaceCandidatesByRow) {
        spacesAfter += this.countInterCharacterSpaces(candidates, y);
      }
      this.interCharacterSpaceCountValue += spacesAfter - spacesBefore;
      this.revision += 1;
      for (const y of spaceCandidatesByRow.keys()) this.touchRow(y, key);
    }
  }

  static fromChunks(chunks: SerializedChunk[]): SparseDocument {
    const document = new SparseDocument();
    for (const chunk of chunks) document.loadChunk(chunk);
    // Older files placed all graphemes one column apart. Resolve overlapping
    // anchors from left to right, preserving the spacing of the shifted suffix.
    const entries = Array.from(document.entries()).sort((a, b) => a[0].y - b[0].y || a[0].x - b[0].x);
    const moves: Array<{ from: Position; to: Position; value: string; style: TextStyle }> = [];
    let row: number | null = null;
    let end = Number.MIN_SAFE_INTEGER;
    let shift = 0;
    for (const [position, value] of entries) {
      if (row !== position.y) { row = position.y; end = Number.MIN_SAFE_INTEGER; shift = 0; }
      const x = Math.max(position.x + shift, end);
      assertSafePosition({ x: x + (graphemeWidth(value) - 1), y: position.y });
      shift = x - position.x;
      end = x + graphemeWidth(value);
      if (x !== position.x) moves.push({ from: position, to: { x, y: position.y }, value, style: document.getStyle(position.x, position.y) });
    }
    for (const move of moves) document.deleteCell(move.from.x, move.from.y);
    for (const move of moves) document.setCell(move.to.x, move.to.y, move.value, move.style);
    return document;
  }
}
