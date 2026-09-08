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
import { DEFAULT_TEXT_STYLE, parseTextStyle, parseLegacyTextStyle, sameStyle, textWidthInCells, textHeightInCells, BASE_FONT_SIZE, type TextStyle, type StyledCell } from "./formatting";
import { placeResizedText } from "./grid-placement";

import { GlyphCoverage, contains, isGlyphSelected, type Footprint } from "./coverage";

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
  private readonly dirtyCountRows = new Set<number>();
  private readonly rowSpaceCounts = new Map<number, number>();
  private interCharacterSpaceCount = 0;
  private readonly coverage = new GlyphCoverage();

  get contentRevision(): number { return this.revision; }
  get hasScaledText(): boolean { return this.coverage.size > 0; }

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
    this.dirtyCountRows.add(y);
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
    const text = this.getCell(x, y);
    if (text) assertSafePosition({ x: x + (textWidthInCells(text, next) - 1), y: y + (textHeightInCells(next) - 1) });
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
    this.updateCoverage(x, y);
    this.markDirty(key);
    this.touchRow(y, key);
  }

  get cellCount(): number {
    // A one-cell gap depends only on anchors and widths in its own row.
    // Recount edited rows lazily, once per batch of document changes.
    for (const y of this.dirtyCountRows) {
      let spaces = 0;
      for (const [p, text] of this.entriesInRow(y)) {
        const end = p.x + textWidthInCells(text, this.getStyle(p.x, p.y));
        if (Number.isSafeInteger(end + 1) && this.getCell(end, p.y) === null && this.getCell(end + 1, p.y) !== null) spaces++;
      }
      this.interCharacterSpaceCount += spaces - (this.rowSpaceCounts.get(y) ?? 0);
      if (spaces) this.rowSpaceCounts.set(y, spaces);
      else this.rowSpaceCounts.delete(y);
    }
    this.dirtyCountRows.clear();
    return this.storedCellCountValue + this.interCharacterSpaceCount;
  }

  footprint(x: number, y: number): Footprint {
    const style = this.getStyle(x, y);
    return { x, y, width: textWidthInCells(this.getCell(x, y) ?? " ", style), height: textHeightInCells(style) };
  }

  private updateCoverage(x: number, y: number): void {
    const text = this.getCell(x, y);
    const style = this.getStyle(x, y);
    this.coverage.set(`${x},${y}`, text && style.fontSize > BASE_FONT_SIZE ? this.footprint(x, y) : null);
  }

  anchorAt(x: number, y: number, include: (position: Position) => boolean = () => true): Position | null {
    if (this.getCell(x, y) !== null && include({ x, y })) return { x, y };
    if (x > Number.MIN_SAFE_INTEGER) {
      const left = this.getCell(x - 1, y);
      if (left && graphemeWidth(left) === 2 && include({ x: x - 1, y })) return { x: x - 1, y };
    }
    return this.coverage.at(x, y, include);
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

  // Every glyph has one anchor; covered base cells are never stored as text.
  getRasterCell(x: number, y: number): string | null {
    const anchor = this.anchorAt(x, y);
    return anchor ? (anchor.x === x && anchor.y === y ? this.getCell(x, y) : "") : null;
  }

  snapPosition(position: Position): Position {
    return this.anchorAt(position.x, position.y) ?? { ...position };
  }

  isInterCharacterSpace(x: number, y: number): boolean {
    assertSafePosition({ x, y });
    return (
      this.getRasterCell(x, y) === null &&
      x > Number.MIN_SAFE_INTEGER &&
      x < Number.MAX_SAFE_INTEGER &&
      this.anchorAt(x - 1, y)?.y === y &&
      this.getCell(x + 1, y) !== null
    );
  }

  getTextCell(x: number, y: number): string | null {
    return this.getCell(x, y) ?? (this.isInterCharacterSpace(x, y) ? " " : null);
  }

  setCell(x: number, y: number, value: string | null, style = DEFAULT_TEXT_STYLE): void {
    assertSafePosition({ x, y });
    style = parseTextStyle(style);
    if (value !== null) {
      assertValidCellValue(value);
      assertSafePosition({ x: x + (textWidthInCells(value, style) - 1), y: y + (textHeightInCells(style) - 1) });
    }
    const nextValue = value === " " ? null : value;

    const { key, index } = chunkAddress({ x, y });
    const chunk = this.chunks.get(key);
    const before = chunk?.get(index) ?? null;
    if (before === nextValue) {
      if (nextValue !== null) this.setStyle(x, y, style);
      return;
    }

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

    this.updateCoverage(x, y);

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

    const visitChunk = (cx: number, cy: number) => {
      const chunk = this.chunks.get(`${cx},${cy}`);
      if (!chunk) return;
      for (const [index, value] of chunk) {
        const x = cx * CHUNK_SIZE + (index % CHUNK_SIZE);
        const y = cy * CHUNK_SIZE + Math.floor(index / CHUNK_SIZE);
        if (this.getStyle(x, y).fontSize > BASE_FONT_SIZE) continue;
        if (x + graphemeWidth(value) > minX && x < maxX && y >= minY && y < maxY &&
          (!fullyContained || (x >= minX && x + graphemeWidth(value) <= maxX))) callback(x, y, value);
      }
    };
    if ((maxCx - minCx + 1) * (maxCy - minCy + 1) < this.chunks.size) {
      for (let cy = minCy; cy <= maxCy; cy++) for (let cx = minCx; cx <= maxCx; cx++) visitChunk(cx, cy);
    } else {
      for (const key of this.chunks.keys()) {
        const { x, y } = parseChunkKey(key);
        if (x >= minCx && x <= maxCx && y >= minCy && y <= maxCy) visitChunk(x, y);
      }
    }
    const selection = { x1: minX, y1: minY, x2: maxX, y2: maxY };
    this.coverage.forEachInRect(selection, (rect) => {
      if (!fullyContained || contains(rect, selection)) callback(rect.x, rect.y, this.getCell(rect.x, rect.y)!);
    });
  }

  forEachInSelection(selection: Selection, callback: (x: number, y: number, value: string) => void, selectedOnly = false): void {
    this.forEachInRect(selection.x1, selection.y1, selection.x2, selection.y2, (x, y, value) => {
      if (selectedOnly) {
        if (isGlyphSelected(this.footprint(x, y), selection)) callback(x, y, value);
        return;
      }
      const range = selectionRowRange(selection, y);
      if (x + this.footprint(x, y).width > range.x1 && x < range.x2) callback(x, y, value);
    });
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
      maxX = Math.max(maxX, position.x + textWidthInCells(value, this.getStyle(position.x, position.y)));
      maxY = Math.max(maxY, position.y + textHeightInCells(this.getStyle(position.x, position.y)));
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
    const loadedRows = new Set<number>();
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
      loadedRows.add(y);
      const style = styles.get(index) ?? DEFAULT_TEXT_STYLE;
      assertSafePosition({ x: x + (textWidthInCells(value, style) - 1), y: y + (textHeightInCells(style) - 1) });
    }
    for (const index of styles.keys()) {
      if (!chunk.has(index)) throw new EditorError("서식에 해당하는 문자가 없습니다.");
    }
    if (styles.size > 0) this.styles.set(key, styles);
    if (chunk.size > 0) {
      this.chunks.set(key, chunk);
      this.storedCellCountValue += chunk.size;
      this.revision += 1;
      for (const y of loadedRows) this.touchRow(y, key);
      for (const [index] of styles) {
        this.updateCoverage(serialized.x * CHUNK_SIZE + index % CHUNK_SIZE, serialized.y * CHUNK_SIZE + Math.floor(index / CHUNK_SIZE));
      }
    }
  }

  static fromChunks(chunks: SerializedChunk[], legacyGrid = false, legacyFontSizes = false): SparseDocument {
    const document = new SparseDocument();
    for (const chunk of chunks) document.loadChunk(legacyFontSizes ? { ...chunk, styles: chunk.styles?.map(([index, style]) => [index, parseLegacyTextStyle(style)]) } : chunk);
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
    if (legacyGrid && document.hasScaledText) {
      const cells = [...document.entries()].map(([position, text]) => ({ position, value: { text, style: document.getStyle(position.x, position.y) } }));
      const placed = placeResizedText(cells, (cell) => cell.value, true);
      for (const cell of cells) document.deleteCell(cell.position.x, cell.position.y);
      for (const cell of placed) document.setCell(cell.position.x, cell.position.y, cell.value.text, cell.value.style);
    }
    if (legacyFontSizes) document.markAllDirty(chunks.map((chunk) => `${chunk.x},${chunk.y}`));
    return document;
  }
}
