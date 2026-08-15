import {
  Bounds,
  CHUNK_CELL_COUNT,
  CHUNK_SIZE,
  EditorError,
  Position,
  assertSafePosition,
} from "./types";
import { assertValidCellValue } from "./graphemes";

export type ChunkKey = `${number},${number}`;
export type Chunk = Map<number, string>;

export type SerializedChunk = {
  x: number;
  y: number;
  cells: Array<[number, string]>;
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
  private readonly dirtyRevisions = new Map<ChunkKey, number>();
  private revision = 0;
  private storedCellCountValue = 0;
  private interCharacterSpaceCountValue = 0;

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

  isInterCharacterSpace(x: number, y: number): boolean {
    assertSafePosition({ x, y });
    return (
      this.getCell(x, y) === null &&
      x > Number.MIN_SAFE_INTEGER &&
      x < Number.MAX_SAFE_INTEGER &&
      this.getCell(x - 1, y) !== null &&
      this.getCell(x + 1, y) !== null
    );
  }

  getTextCell(x: number, y: number): string | null {
    return this.getCell(x, y) ?? (this.isInterCharacterSpace(x, y) ? " " : null);
  }

  private spaceCandidates(x: number): number[] {
    const candidates = [x];
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

  setCell(x: number, y: number, value: string | null): void {
    assertSafePosition({ x, y });
    if (value !== null) assertValidCellValue(value);
    const nextValue = value === " " ? null : value;

    const { key, index } = chunkAddress({ x, y });
    const chunk = this.chunks.get(key);
    const before = chunk?.get(index) ?? null;
    if (before === nextValue) return;
    const spaceCandidates = this.spaceCandidates(x);
    const spacesBefore = this.countInterCharacterSpaces(spaceCandidates, y);

    if (nextValue === null) {
      if (!chunk) return;
      chunk.delete(index);
      this.storedCellCountValue -= 1;
      if (chunk.size === 0) this.chunks.delete(key);
    } else {
      const target = chunk ?? new Map<number, string>();
      if (!chunk) this.chunks.set(key, target);
      if (before === null) this.storedCellCountValue += 1;
      target.set(index, nextValue);
    }

    const spacesAfter = this.countInterCharacterSpaces(spaceCandidates, y);
    this.interCharacterSpaceCountValue += spacesAfter - spacesBefore;

    this.markDirty(key);
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
  ): void {
    if (maxX <= minX || maxY <= minY) return;
    const minCx = Math.floor(minX / CHUNK_SIZE);
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
          if (x >= minX && x < maxX && y >= minY && y < maxY) {
            callback(x, y, value);
          }
        }
      }
    }
  }

  bounds(): Bounds | null {
    if (this.storedCellCountValue === 0) return null;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const [position] of this.entries()) {
      minX = Math.min(minX, position.x);
      minY = Math.min(minY, position.y);
      maxX = Math.max(maxX, position.x + 1);
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
      if (value === " ") continue;
      chunk.set(index, value);
      const candidates = spaceCandidatesByRow.get(y) ?? new Set<number>();
      for (const candidate of this.spaceCandidates(x)) candidates.add(candidate);
      spaceCandidatesByRow.set(y, candidates);
    }
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
    }
  }

  static fromChunks(chunks: SerializedChunk[]): SparseDocument {
    const document = new SparseDocument();
    for (const chunk of chunks) document.loadChunk(chunk);
    return document;
  }
}
