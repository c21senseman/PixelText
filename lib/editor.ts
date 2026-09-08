import { contentRows, placedContentRows } from "./text-raster";
import { SparseDocument } from "./document";
import { getTextLayout } from "./layout";
import { DEFAULT_TEXT_STYLE, cellStyle, cellText, contentWidth, textWidthInCells, textHeightInCells, parseTextStyle, sameStyle, type CellContent, type FormattingState, type StyleToggle, type TextStyle } from "./formatting";
import { GlyphCoverage, contains, intersects } from "./coverage";
import { placeResizedText, type PlacedCell } from "./grid-placement";
import { footprint, cellRect, moveCell, connectedCells, pushOutside, textRun } from "./spatial";
import {
  assertValidCellValue,
  graphemeWidth,
  hasControlCharacter,
  normalizeTextInput,
  segmentGraphemes,
} from "./graphemes";
import {
  Bookmark,
  Change,
  EditorError,
  EditorSnapshot,
  HistoryBatch,
  MAX_BOOKMARK_NAME_LENGTH,
  MAX_BOOKMARKS,
  Position,
  SearchResult,
  Selection,
  SelectionReflow,
  assertSafePosition,
  assertTextRasterSize,
  cloneSelection,
  normalizeSelection,
  safeAdd,
  selectionRowRange,
  isPointInSelection,
} from "./types";

const HISTORY_LIMIT = 500;

function coordinateKey(x: number, y: number): string {
  return `${x},${y}`;
}

function snapshotState(
  cursor: Position,
  selection: Selection | null,
  selectionReflow: SelectionReflow | null,
  typingStyle: TextStyle,
): EditorSnapshot {
  return {
    cursor: { ...cursor },
    selection: cloneSelection(selection),
    selectionReflow,
    typingStyle,
  };
}

function translateSelection(
  selection: Selection,
  dx: number,
  dy: number,
): Selection {
  return {
    x1: safeAdd(selection.x1, dx),
    y1: safeAdd(selection.y1, dy),
    x2: safeAdd(selection.x2, dx),
    y2: safeAdd(selection.y2, dy),
    ...(selection.rows ? { rows: selection.rows.map((row) => ({ y: safeAdd(row.y, dy), x1: safeAdd(row.x1, dx), x2: safeAdd(row.x2, dx) })) } : {}),
  };
}

function translateSelectionReflow(
  selectionReflow: SelectionReflow | null,
  dx: number,
): SelectionReflow | null {
  if (!selectionReflow || dx === 0) return selectionReflow;
  return {
    lines: selectionReflow.lines.map((line) => ({
      cells: line.cells,
      lineStartX: safeAdd(line.lineStartX, dx),
    })),
  };
}

function cardinalStepBetween(from: Position, to: Position): Position {
  let dx = to.x - from.x;
  let dy = to.y - from.y;
  if (dx === 0 && dy === 0) {
    dx = to.x;
    dy = to.y;
  }
  if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) {
    return { x: Math.sign(dx), y: 0 };
  }
  return { x: 0, y: Math.sign(dy) };
}

class Transaction {
  private readonly changes = new Map<string, Change>();
  private readonly coverage = new GlyphCoverage();

  constructor(private readonly document: SparseDocument) {}

  entries(): PlacedCell[] {
    const cells: PlacedCell[] = [];
    for (const [position, text] of this.document.entries()) {
      if (!this.changes.has(coordinateKey(position.x, position.y))) cells.push({ position, value: { text, style: this.document.getStyle(position.x, position.y) } });
    }
    for (const change of this.changes.values()) {
      if (change.after) cells.push({ position: { x: change.x, y: change.y }, value: { text: change.after, style: change.afterStyle } });
    }
    return cells;
  }

  anchorAt(x: number, y: number): Position | null {
    const pending = this.coverage.at(x, y, (p) => p.y === y);
    if (pending) return pending;
    return this.document.anchorAt(x, y, (p) => p.y === y && !this.changes.has(coordinateKey(p.x, p.y)));
  }

  rowHeight(y: number): number {
    let height = 1;
    for (const cell of this.entries()) if (cell.position.y === y) height = Math.max(height, textHeightInCells(cell.value.style));
    return height;
  }

  replace(cells: PlacedCell[]): void {
    for (const cell of this.entries()) this.set(cell.position.x, cell.position.y, null);
    for (const cell of cells) this.set(cell.position.x, cell.position.y, cell.value);
  }

  get scaled(): boolean {
    return this.document.hasScaledText || [...this.changes.values()].some((change) => !!change.after && change.afterStyle.fontSize > 1);
  }

  read(x: number, y: number): CellContent | null {
    const text = this.get(x, y);
    if (!text) return text;
    const style = this.changes.get(coordinateKey(x, y))?.afterStyle ?? this.document.getStyle(x, y);
    return { text, style };
  }

  get(x: number, y: number): string | null {
    assertSafePosition({ x, y });
    const pending = this.changes.get(coordinateKey(x, y));
    const value = pending ? pending.after : this.document.getCell(x, y);
    if (value !== null) return value;
    if (x > Number.MIN_SAFE_INTEGER) {
      const leftChange = this.changes.get(coordinateKey(x - 1, y));
      const left = leftChange ? leftChange.after : this.document.getCell(x - 1, y);
      if (left && graphemeWidth(left) === 2) return "";
    }
    if (this.anchorAt(x, y)) return "";
    return null;
  }

  set(x: number, y: number, content: CellContent | null): void {
    assertSafePosition({ x, y });
    const after = content === null ? null : cellText(content);
    const nextValue = after === " " ? null : after;
    const afterStyle = nextValue && content ? cellStyle(content) : DEFAULT_TEXT_STYLE;
    const key = coordinateKey(x, y);
    this.coverage.set(key, nextValue ? { x, y, width: textWidthInCells(nextValue, afterStyle), height: textHeightInCells(afterStyle) } : null);
    const existing = this.changes.get(key);
    if (existing) {
      existing.after = nextValue;
      existing.afterStyle = afterStyle;
      return;
    }
    this.changes.set(key, {
      x,
      y,
      before: this.document.getCell(x, y),
      after: nextValue,
      beforeStyle: this.document.getStyle(x, y),
      afterStyle,
    });
  }

  isInterCharacterSpace(x: number, y: number): boolean {
    assertSafePosition({ x, y });
    return (
      this.get(x, y) === null &&
      x > Number.MIN_SAFE_INTEGER &&
      x < Number.MAX_SAFE_INTEGER &&
      this.get(x - 1, y) !== null &&
      this.get(x + 1, y) !== null
    );
  }

  isVerticalBlockGap(x: number, y: number): boolean {
    assertSafePosition({ x, y });
    return (
      this.get(x, y) === null &&
      y > Number.MIN_SAFE_INTEGER &&
      y < Number.MAX_SAFE_INTEGER &&
      this.get(x, y - 1) !== null &&
      this.get(x, y + 1) !== null
    );
  }

  isTextCell(x: number, y: number): boolean {
    return this.get(x, y) !== null || this.isInterCharacterSpace(x, y);
  }

  finalChanges(): Change[] {
    return Array.from(this.changes.values(), (change) => ({
      ...change, after: change.after === "" ? null : change.after,
    })).filter(
      (change) => change.before !== change.after || !sameStyle(change.beforeStyle, change.afterStyle),
    );
  }
}

export type EditorChangeKind = "transient" | "document" | "bookmarks";
export type EditorListener = (change: EditorChangeKind) => void;
export type SelectionResizeEdge = "left" | "right" | "top" | "bottom";
export type SelectionMoveOptions = {
  pushDirection?: Position;
  lastNonOverlappingOffset?: Position;
};

export class EditorModel {
  document: SparseDocument;
  cursor: Position = { x: 0, y: 0 };
  selection: Selection | null = null;
  overwriteMode = false;
  bookmarks: Bookmark[] = [];
  searchResults: SearchResult[] = [];
  searchIndex = -1;
  typingStyle: TextStyle = DEFAULT_TEXT_STYLE;

  private undoStack: HistoryBatch[] = [];
  private redoStack: HistoryBatch[] = [];
  private selectionReflow: SelectionReflow | null = null;
  private preferredCursorX: number | null = null;
  private readonly listeners = new Set<EditorListener>();

  constructor(document = new SparseDocument()) {
    this.document = document;
  }

  subscribe(listener: EditorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: EditorChangeKind = "transient"): void {
    for (const listener of this.listeners) listener(change);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get cursorBounds(): Selection {
    const text = this.document.getCell(this.cursor.x, this.cursor.y);
    const style = this.overwriteMode && text ? this.document.getStyle(this.cursor.x, this.cursor.y) : this.typingStyle;
    return getTextLayout(this.document).caretRect(this.cursor, style, this.overwriteMode ? graphemeWidth(text ?? " ") : 1);
  }

  get formatting(): FormattingState {
    if (!this.selection) return { ...this.typingStyle };
    let state: FormattingState | null = null;
    const s = this.selection;
    this.document.forEachInSelection(s, (x, y) => {
      const style = this.document.getStyle(x, y);
      if (state === null) state = { ...style };
      else {
        for (const key of ["bold", "italic", "underline", "strikethrough"] as const) {
          if (state[key] !== style[key]) state[key] = null;
        }
        if (state.fontSize !== style.fontSize) state.fontSize = null;
      }
    }, true);
    return state ?? { ...this.typingStyle };
  }

  private inheritTypingStyle(): void {
    if (this.cursor.x === Number.MIN_SAFE_INTEGER) return;
    const left = this.document.snapPosition({ x: this.cursor.x - 1, y: this.cursor.y });
    if (this.document.getCell(left.x, left.y) !== null) this.typingStyle = this.document.getStyle(left.x, left.y);
  }

  toggleStyle(key: StyleToggle): void {
    this.applyStyle({ [key]: this.formatting[key] !== true });
  }

  applyStyle(patch: Partial<TextStyle>): void {
    const next = parseTextStyle({ ...this.typingStyle, ...patch });
    if (!this.selection) {
      this.typingStyle = next;
      this.emit();
      return;
    }
    const before = snapshotState(this.cursor, this.selection, this.selectionReflow, this.typingStyle);
    const transaction = new Transaction(this.document);
    const s = this.selection;
    if (patch.fontSize !== undefined && patch.fontSize !== this.formatting.fontSize) {
      const selected = new Set<string>();
      this.document.forEachInSelection(s, (x, y) => selected.add(coordinateKey(x, y)), true);
      const placed = placeResizedText(transaction.entries(), (cell) => selected.has(coordinateKey(cell.position.x, cell.position.y))
        ? { text: cell.value.text, style: parseTextStyle({ ...cell.value.style, ...patch }) } : cell.value);
      let selection: Selection | null = null;
      for (const cell of placed) transaction.set(cell.from.x, cell.from.y, null);
      for (const cell of placed) {
        transaction.set(cell.position.x, cell.position.y, cell.value);
        if (selected.has(coordinateKey(cell.from.x, cell.from.y))) {
          const rect = { x1: cell.position.x, y1: cell.position.y, x2: cell.position.x + contentWidth(cell.value), y2: cell.position.y + textHeightInCells(cell.value.style) };
          selection = selection ? { x1: Math.min(selection.x1, rect.x1), y1: Math.min(selection.y1, rect.y1), x2: Math.max(selection.x2, rect.x2), y2: Math.max(selection.y2, rect.y2) } : rect;
        }
      }
      this.commit(transaction, before, selection ? { x: selection.x1, y: selection.y1 } : this.cursor, selection ?? s, null, next);
      return;
    }
    this.document.forEachInSelection(s, (x, y, text) => {
      transaction.set(x, y, { text, style: parseTextStyle({ ...this.document.getStyle(x, y), ...patch }) });
    }, true);
    const reflow = this.selectionReflow && { lines: this.selectionReflow.lines.map((line) => ({
      ...line, cells: line.cells.map((cell) => cell && ({ text: cellText(cell), style: parseTextStyle({ ...cellStyle(cell), ...patch }) })),
    })) };
    this.typingStyle = next;
    this.commit(transaction, before, this.cursor, s, reflow);
  }

  setCursor(position: Position, clearSelection = true): void {
    assertSafePosition(position);
    this.cursor = this.document.snapPosition(position);
    this.preferredCursorX = null;
    this.inheritTypingStyle();
    if (clearSelection) {
      this.selection = null;
      this.selectionReflow = null;
    }
    this.emit();
  }

  moveCursor(dx: number, dy: number): void {
    let x = safeAdd(this.cursor.x, dx);
    let y = safeAdd(this.cursor.y, dy);
    const current = this.document.anchorAt(this.cursor.x, this.cursor.y);
    const left = this.cursor.x > Number.MIN_SAFE_INTEGER ? this.document.anchorAt(this.cursor.x - 1, this.cursor.y) : null;
    if (dy !== 0) {
      let height = current?.y === this.cursor.y ? this.document.footprint(current.x, current.y).height
        : left?.y === this.cursor.y ? this.document.footprint(left.x, left.y).height : 1;
      const runAt = (rowY: number, x: number) => textRun([...this.document.entriesInRow(rowY)].map(([position, text]) => ({ position, value: { text, style: this.document.getStyle(position.x, rowY) } })), { x, y: rowY });
      if (this.document.hasScaledText) for (const cell of runAt(this.cursor.y, this.cursor.x)) height = Math.max(height, cell.value.style.fontSize);
      if (dy > 0) y = safeAdd(this.cursor.y, Math.max(dy, height));
      const preferred = this.preferredCursorX ?? this.cursor.x;
      if (dy < 0 && this.document.hasScaledText) {
        for (const rowY of [...this.document.rowKeys()].filter((rowY) => rowY < this.cursor.y).sort((a, b) => b - a)) {
          const run = runAt(rowY, preferred);
          if (run.some((cell) => rowY + cell.value.style.fontSize > y)) { y = rowY; break; }
        }
      }
      x = getTextLayout(this.document).nearestCursorX(preferred, y);
      this.setCursor({ x, y });
      this.preferredCursorX = preferred;
      return;
    }
    if (dx > 0 && current) x = safeAdd(this.cursor.x, Math.max(dx, this.document.footprint(current.x, current.y).width));
    this.setCursor({ x, y });
  }

  moveCursorOrSelection(dx: number, dy: number): void {
    if (this.selection) {
      const pushDirection = dx !== 0
        ? { x: Math.sign(dx), y: 0 }
        : { x: 0, y: Math.sign(dy) };
      this.moveSelection(dx, dy, { pushDirection });
      return;
    }
    this.moveCursor(dx, dy);
  }

  toggleOverwriteMode(): void {
    this.overwriteMode = !this.overwriteMode;
    this.emit();
  }

  setSelection(selection: Selection | null): void {
    this.selectionReflow = null;
    if (!selection) {
      this.selection = null;
      this.inheritTypingStyle();
      this.emit();
      return;
    }
    const normalized = normalizeSelection(selection);
    assertSafePosition({ x: normalized.x1, y: normalized.y1 });
    assertSafePosition({ x: normalized.x2, y: normalized.y2 });
    if (normalized.rows) {
      let previousY = Number.NEGATIVE_INFINITY;
      for (const row of normalized.rows) {
        assertSafePosition({ x: row.x1, y: row.y });
        assertSafePosition({ x: row.x2, y: row.y });
        if (row.y <= previousY || row.y < normalized.y1 || row.y >= normalized.y2 ||
          row.x1 < normalized.x1 || row.x2 > normalized.x2 || row.x2 < row.x1) {
          throw new EditorError("선택 영역의 행 범위가 올바르지 않습니다.");
        }
        previousY = row.y;
      }
    }
    this.selection =
      normalized.x1 === normalized.x2 || normalized.y1 === normalized.y2
        ? null
        : normalized;
    this.emit();
  }

  private selectedRasterCell(
    transaction: Transaction,
    selection: Selection,
    x: number,
    y: number,
  ): CellContent | null {
    const range = selectionRowRange(selection, y);
    if (x < range.x1 || x >= range.x2) return null;
    const value = transaction.read(x, y);
    if (value === "") {
      const anchor = transaction.anchorAt(x, y);
      if (!anchor) return null;
      const source = transaction.read(anchor.x, anchor.y);
      if (!source || anchor.x < range.x1 || anchor.x + contentWidth(source) > range.x2 || y + textHeightInCells(cellStyle(source)) > selection.y2) return null;
    }
    if (value && (contentWidth(value) > range.x2 - x || y + textHeightInCells(cellStyle(value)) > selection.y2)) return null;
    return value;
  }

  private clearSelectionInTransaction(transaction: Transaction): Position | null {
    const selection = this.selection;
    if (!selection) return null;
    this.document.forEachInSelection(
      selection,
      (x, y) => transaction.set(x, y, null),
      true,
    );
    return { x: selectionRowRange(selection, selection.y1).x1, y: selection.y1 };
  }

  private clearSelectionAndPullLeft(
    transaction: Transaction,
    selection: Selection,
  ): Position {
    if (transaction.scaled) {
      const cells = transaction.entries();
      const removed = new Set(cells.filter((cell) => contains(footprint(cell), selection)));
      const moving = new Set<PlacedCell>();
      for (const y of new Set(cells.filter((cell) => cell.position.y >= selection.y1 && cell.position.y < selection.y2).map((cell) => cell.position.y))) {
        if (cells.some((cell) => cell.position.y === y && intersects(footprint(cell), selection) && !removed.has(cell))) continue;
        for (const cell of textRun(cells, { x: selection.x2, y })) if (cell.position.x >= selection.x2) moving.add(cell);
      }
      this.replaceWithoutCollisions(transaction, cells.filter((cell) => !removed.has(cell)), new Map([...moving].map((cell) => [cell, moveCell(cell, selection.x1 - selection.x2, 0)])), "다른 문자 블록과 충돌하여 선택 영역을 당길 수 없습니다.");
      return { x: selection.x1, y: selection.y1 };
    }
    const moving: Array<{
      fromX: number;
      toX: number;
      y: number;
      value: CellContent;
    }> = [];

    for (let y = selection.y1; y < selection.y2; y += 1) {
      const range = selectionRowRange(selection, y);
      const width = range.x2 - range.x1;
      // A boundary-crossing glyph stays intact, so this row cannot collapse.
      if (transaction.get(range.x1, y) === "" || transaction.get(range.x2, y) === "") continue;
      let x = range.x2;
      while (transaction.isTextCell(x, y)) {
        const value = transaction.read(x, y);
        if (value !== null) {
          moving.push({
            fromX: x,
            toX: safeAdd(x, -width),
            y,
            value,
          });
        }
        if (x === Number.MAX_SAFE_INTEGER) break;
        x += 1;
      }
      if (y === Number.MAX_SAFE_INTEGER) break;
    }

    this.clearSelectionInTransaction(transaction);
    for (const item of moving) transaction.set(item.fromX, item.y, null);
    for (const item of moving) {
      transaction.set(item.toX, item.y, item.value);
    }
    return { x: selectionRowRange(selection, selection.y1).x1, y: selection.y1 };
  }

  private commit(
    transaction: Transaction,
    before: EditorSnapshot,
    cursor: Position,
    selection: Selection | null,
    selectionReflow: SelectionReflow | null = null,
    typingStyle: TextStyle = this.typingStyle,
  ): void {
    assertSafePosition(cursor);
    const changes = transaction.finalChanges();
    for (const change of changes) {
      if (change.after !== null) {
        assertValidCellValue(change.after);
        assertSafePosition({ x: change.x + (textWidthInCells(change.after, change.afterStyle) - 1), y: change.y + (textHeightInCells(change.afterStyle) - 1) });
      }
    }
    for (const change of changes) {
      this.document.setCell(change.x, change.y, change.after, change.afterStyle);
    }
    this.cursor = this.document.snapPosition(cursor);
    this.preferredCursorX = null;
    this.typingStyle = typingStyle;
    if (!selection) this.inheritTypingStyle();
    this.selection = cloneSelection(selection);
    this.selectionReflow = selection ? selectionReflow : null;

    if (changes.length > 0) {
      this.undoStack.push({
        changes,
        before,
        after: snapshotState(
          this.cursor,
          this.selection,
          this.selectionReflow,
          this.typingStyle,
        ),
      });
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this.searchResults = [];
      this.searchIndex = -1;
    }
    this.emit(changes.length > 0 ? "document" : "transient");
  }

  private insertOne(
    transaction: Transaction,
    position: Position,
    grapheme: string,
    style = this.typingStyle,
  ): Position {
    const width = textWidthInCells(grapheme, style);
    const nextCursor = { x: safeAdd(position.x, width), y: position.y };
    if (transaction.scaled || style.fontSize > 1) {
      const cells = transaction.entries();
      const added: PlacedCell = { position, value: { text: grapheme, style } };
      const row = cells.filter((cell) => cell.position.y === position.y);
      const moving = new Set<PlacedCell>();
      for (const cell of row) {
        if (intersects(footprint(cell), cellRect(added))) {
          for (const item of textRun(row, cell.position)) if (item.position.x >= position.x) moving.add(item);
        }
      }
      const shifted = [...moving].map((cell) => moveCell(cell, width, 0));
      const fixed = row.filter((cell) => !moving.has(cell));
      const placed = [...pushOutside(fixed, [...shifted, added].map(cellRect), { x: 1, y: 0 }), ...shifted, added];
      const outside = pushOutside(cells.filter((cell) => cell.position.y !== position.y), placed.map(cellRect), { x: 0, y: 1 });
      transaction.replace([...outside, ...placed]);
      return nextCursor;
    }
    // Include any run touched by the new glyph, including its second column.
    let end = position.x;
    for (let offset = 0; offset < width; offset += 1) {
      const x = safeAdd(position.x, offset);
      if (transaction.isTextCell(x, position.y)) end = safeAdd(x, 1);
    }
    while (end > position.x && transaction.isTextCell(end, position.y)) end = safeAdd(end, 1);
    const moving: Array<[number, CellContent | null]> = [];
    for (let x = position.x; x < end; x += 1) moving.push([x, transaction.read(x, position.y)]);
    for (const [x] of moving) transaction.set(x, position.y, null);
    for (const [x, value] of moving) transaction.set(safeAdd(x, width), position.y, value);
    transaction.set(position.x, position.y, { text: grapheme, style });
    return nextCursor;
  }

  private insertBlank(
    transaction: Transaction,
    position: Position,
    style = this.typingStyle,
  ): Position {
    if (transaction.isInterCharacterSpace(position.x, position.y)) {
      return { x: safeAdd(position.x, 1), y: position.y };
    }

    return this.insertOne(transaction, position, " ", style);
  }

  private overwriteOne(
    transaction: Transaction,
    position: Position,
    grapheme: string,
    style = this.typingStyle,
  ): Position {
    const width = textWidthInCells(grapheme, style);
    const nextCursor = { x: safeAdd(position.x, width), y: position.y };
    if (transaction.scaled || style.fontSize > 1) {
      const added: PlacedCell = { position, value: { text: grapheme, style } };
      transaction.replace([...transaction.entries().filter((cell) => !intersects(footprint(cell), cellRect(added))), added]);
      return nextCursor;
    }
    for (let x = position.x; x < nextCursor.x; x += 1) {
      if (transaction.get(x, position.y) === "") transaction.set(x - 1, position.y, null);
      transaction.set(x, position.y, null);
    }
    transaction.set(position.x, position.y, { text: grapheme, style });
    return nextCursor;
  }

  insertText(rawText: string, styles?: ReadonlyMap<number, TextStyle>): void {
    const text = normalizeTextInput(rawText);
    if (text.length === 0) return;
    const lines = text.split("\n");
    const segmentedLines = lines.map((line) => segmentGraphemes(line));
    const width = segmentedLines.reduce(
      (maximum, line) => Math.max(maximum, line.reduce((sum, value) => {
        assertValidCellValue(value);
        return sum + contentWidth(value);
      }, 0)),
      0,
    );
    assertTextRasterSize(width, segmentedLines.length);
    const before = snapshotState(
      this.cursor,
      this.selection,
      this.selectionReflow,
      this.typingStyle,
    );
    const inputStyle = { ...this.typingStyle };
    const formatting = this.formatting;
    for (const key of ["bold", "italic", "underline", "strikethrough"] as const) {
      if (formatting[key] !== null) inputStyle[key] = formatting[key];
    }
    if (formatting.fontSize !== null) inputStyle.fontSize = formatting.fontSize;
    if (styles) for (const style of styles.values()) parseTextStyle(style);
    const transaction = new Transaction(this.document);
    const selectionStart = this.clearSelectionInTransaction(transaction);
    const start = { ...(selectionStart ?? this.cursor) };
    const coveredStart = transaction.anchorAt(start.x, start.y);
    if (coveredStart && coveredStart.x < start.x) start.x = safeAdd(coveredStart.x, contentWidth(transaction.read(coveredStart.x, coveredStart.y)!));
    let finalCursor = { ...start };
    let textIndex = 0;
    let lastStyle: TextStyle = inputStyle;

    let y = start.y;
    for (let row = 0; row < segmentedLines.length; row += 1) {
      let lineCursor: Position = { x: start.x, y };
      let height = segmentedLines[row].length ? 1 : textHeightInCells(lastStyle);
      for (const grapheme of segmentedLines[row]) {
        lastStyle = styles?.get(textIndex) ?? (styles ? DEFAULT_TEXT_STYLE : inputStyle);
        height = Math.max(height, textHeightInCells(lastStyle));
        textIndex += 1;
        if (this.overwriteMode) {
          lineCursor = this.overwriteOne(transaction, lineCursor, grapheme, lastStyle);
        } else if (grapheme === " ") {
          lineCursor = this.insertBlank(transaction, lineCursor, lastStyle);
        } else {
          lineCursor = this.insertOne(transaction, lineCursor, grapheme, lastStyle);
        }
      }
      finalCursor = lineCursor;
      if (row < segmentedLines.length - 1) y = safeAdd(y, height);
    }

    this.commit(transaction, before, finalCursor, null, null, lastStyle);
  }

  private deleteAndPull(
    transaction: Transaction,
    startX: number,
    y: number,
    width: number,
  ): void {
    if (transaction.scaled) {
      const cells = transaction.entries();
      const run = new Set(textRun(cells, { x: startX, y }));
      const kept = cells.filter((cell) => !run.has(cell) || cell.position.x < startX || cell.position.x >= startX + width);
      const moved = new Map(kept.filter((cell) => run.has(cell) && cell.position.x >= startX + width).map((cell) => [cell, moveCell(cell, -width, 0)]));
      this.replaceWithoutCollisions(transaction, kept, moved, "다른 문자 블록과 충돌하여 문자를 당길 수 없습니다.");
      return;
    }
    let lastX = startX;
    while (transaction.isTextCell(lastX, y)) {
      if (lastX === Number.MAX_SAFE_INTEGER) break;
      lastX += 1;
    }
    if (!transaction.isTextCell(lastX, y)) lastX -= 1;

    const cells: Array<[number, CellContent | null]> = [];
    for (let x = startX; x <= lastX; x += 1) {
      const sourceX = x <= Number.MAX_SAFE_INTEGER - width ? x + width : null;
      cells.push([x, sourceX !== null && sourceX <= lastX ? transaction.read(sourceX, y) : null]);
      if (x === Number.MAX_SAFE_INTEGER) break;
    }
    for (const [x] of cells) transaction.set(x, y, null);
    for (const [x, value] of cells) transaction.set(x, y, value);
  }

  private pullTextRunLeft(
    transaction: Transaction,
    startX: number,
    y: number,
  ): void {
    if (transaction.scaled) {
      const cells = transaction.entries();
      const run = new Set(textRun(cells, { x: startX, y }));
      this.replaceWithoutCollisions(transaction, cells, new Map(cells.filter((cell) => run.has(cell) && cell.position.x >= startX).map((cell) => [cell, moveCell(cell, -1, 0)])), "다른 문자 블록과 충돌하여 문자를 당길 수 없습니다.");
      return;
    }
    let endX = startX;
    while (transaction.isTextCell(endX, y)) {
      if (endX === Number.MAX_SAFE_INTEGER) break;
      endX += 1;
    }
    if (!transaction.isTextCell(endX, y)) endX -= 1;

    for (let sourceX = startX; sourceX <= endX; sourceX += 1) {
      transaction.set(sourceX - 1, y, transaction.read(sourceX, y));
      if (sourceX === Number.MAX_SAFE_INTEGER) break;
    }
    transaction.set(endX, y, null);
  }

  private joinCurrentLineToPrevious(
    transaction: Transaction,
    position: Position,
  ): Position | null {
    if (transaction.scaled) {
      const cells = transaction.entries();
      const current = textRun(cells, position);
      if (current.length && current[0].position.x !== position.x) return null;
      const above = cells.filter((cell) => cell.position.x === position.x && cell.position.y < position.y)
        .sort((a, b) => b.position.y - a.position.y)[0];
      if (!above) return null;
      const previous = textRun(cells, above.position);
      if (previous[0].position.x !== position.x) return null;
      const previousHeight = Math.max(...previous.map((cell) => textHeightInCells(cell.value.style)));
      if (above.position.y + previousHeight !== position.y) return null;
      const end = previous.at(-1)!.position.x + contentWidth(previous.at(-1)!.value);
      const nextCursor = { x: end, y: above.position.y };
      assertSafePosition(nextCursor);
      if (!current.length) return nextCursor;
      const currentHeight = Math.max(...current.map((cell) => textHeightInCells(cell.value.style)));
      const collapse = Math.min(previousHeight, currentHeight);
      const block = connectedCells(cells, current);
      const joined = new Set(current);
      const moved = new Map<PlacedCell, PlacedCell>();
      for (const cell of block) {
        if (joined.has(cell)) moved.set(cell, moveCell(cell, end - position.x, above.position.y - position.y));
        else if (cell.position.y > position.y) moved.set(cell, moveCell(cell, 0, -collapse));
      }
      this.replaceWithoutCollisions(transaction, cells, moved, "다른 문자 블록과 충돌하여 Backspace로 줄을 붙일 수 없습니다.");
      return nextCursor;
    }
    if (position.y === Number.MIN_SAFE_INTEGER) return null;
    if (
      position.x > Number.MIN_SAFE_INTEGER &&
      transaction.isTextCell(position.x - 1, position.y)
    ) {
      return null;
    }

    const previousY = position.y - 1;
    if (transaction.get(position.x, previousY) === null) return null;
    if (
      position.x > Number.MIN_SAFE_INTEGER &&
      transaction.isTextCell(position.x - 1, previousY)
    ) {
      return null;
    }

    let x = position.x;
    while (transaction.isTextCell(x, previousY)) {
      x = safeAdd(x, 1);
    }
    const previousLineEnd = x;

    if (transaction.get(position.x, position.y) === null) {
      return { x: previousLineEnd, y: previousY };
    }

    let currentLineEnd = position.x;
    while (
      currentLineEnd < Number.MAX_SAFE_INTEGER &&
      transaction.isTextCell(currentLineEnd + 1, position.y)
    ) {
      currentLineEnd += 1;
    }

    const queue: Position[] = [];
    const visited = new Set<string>();
    for (let currentX = position.x; currentX <= currentLineEnd; currentX += 1) {
      const key = coordinateKey(currentX, position.y);
      visited.add(key);
      queue.push({ x: currentX, y: position.y });
      if (currentX === Number.MAX_SAFE_INTEGER) break;
    }

    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const neighborX = current.x + dx;
          const neighborY = current.y + dy;
          if (
            !Number.isSafeInteger(neighborX) ||
            !Number.isSafeInteger(neighborY)
          ) {
            continue;
          }
          const key = coordinateKey(neighborX, neighborY);
          if (
            visited.has(key) ||
            !transaction.isTextCell(neighborX, neighborY)
          ) {
            continue;
          }
          visited.add(key);
          queue.push({ x: neighborX, y: neighborY });
        }
      }
    }

    const moving: Array<{ from: Position; to: Position; value: CellContent }> = [];
    for (let currentX = position.x; currentX <= currentLineEnd; currentX += 1) {
      const value = transaction.read(currentX, position.y);
      if (value !== null) {
        moving.push({
          from: { x: currentX, y: position.y },
          to: {
            x: safeAdd(previousLineEnd, currentX - position.x),
            y: previousY,
          },
          value,
        });
      }
      if (currentX === Number.MAX_SAFE_INTEGER) break;
    }
    for (const current of queue) {
      if (current.y <= position.y) continue;
      const value = transaction.read(current.x, current.y);
      if (value !== null) {
        moving.push({
          from: current,
          to: { x: current.x, y: current.y - 1 },
          value,
        });
      }
    }

    const sourceKeys = new Set(
      moving.map((item) => coordinateKey(item.from.x, item.from.y)),
    );
    const destinationKeys = new Set<string>();
    for (const item of moving) {
      const destinationKey = coordinateKey(item.to.x, item.to.y);
      if (
        destinationKeys.has(destinationKey) ||
        (transaction.get(item.to.x, item.to.y) !== null &&
          !sourceKeys.has(destinationKey))
      ) {
        throw new EditorError(
          "다른 문자 블록과 충돌하여 Backspace로 줄을 붙일 수 없습니다.",
        );
      }
      destinationKeys.add(destinationKey);
    }

    for (const item of moving) transaction.set(item.from.x, item.from.y, null);
    for (const item of moving) transaction.set(item.to.x, item.to.y, item.value);
    return { x: previousLineEnd, y: previousY };
  }

  backspace(): void {
    const before = snapshotState(
      this.cursor,
      this.selection,
      this.selectionReflow,
      this.typingStyle,
    );
    const transaction = new Transaction(this.document);
    const selection = this.selection;
    if (selection) {
      const selectionStart = this.clearSelectionAndPullLeft(
        transaction,
        selection,
      );
      this.commit(transaction, before, selectionStart, null);
      return;
    }

    const previousLineCursor = this.joinCurrentLineToPrevious(
      transaction,
      this.cursor,
    );
    if (previousLineCursor) {
      this.commit(transaction, before, previousLineCursor, null);
      return;
    }

    if (this.cursor.x === Number.MIN_SAFE_INTEGER) return;
    const targetX = transaction.anchorAt(this.cursor.x - 1, this.cursor.y)?.x ?? this.cursor.x - 1;
    const deletedWidth = this.cursor.x - targetX;
    if (transaction.isTextCell(targetX, this.cursor.y)) {
      const joinsTwoSpaces =
        transaction.get(targetX, this.cursor.y) !== null &&
        targetX > Number.MIN_SAFE_INTEGER &&
        targetX < Number.MAX_SAFE_INTEGER &&
        transaction.isInterCharacterSpace(targetX - 1, this.cursor.y) &&
        transaction.isInterCharacterSpace(targetX + deletedWidth, this.cursor.y);
      this.deleteAndPull(
        transaction,
        targetX,
        this.cursor.y,
        deletedWidth + (joinsTwoSpaces ? 1 : 0),
      );
    } else if (transaction.get(this.cursor.x, this.cursor.y) !== null) {
      this.pullTextRunLeft(transaction, this.cursor.x, this.cursor.y);
    }
    this.commit(transaction, before, { x: targetX, y: this.cursor.y }, null);
  }

  deleteForward(): void {
    const before = snapshotState(
      this.cursor,
      this.selection,
      this.selectionReflow,
      this.typingStyle,
    );
    const transaction = new Transaction(this.document);
    const selectionStart = this.clearSelectionInTransaction(transaction);
    if (selectionStart) {
      this.commit(transaction, before, selectionStart, null);
      return;
    }

    if (!transaction.isTextCell(this.cursor.x, this.cursor.y)) return;
    const deletedWidth = contentWidth(transaction.read(this.cursor.x, this.cursor.y) ?? " ");
    const joinsTwoSpaces =
      transaction.get(this.cursor.x, this.cursor.y) !== null &&
      this.cursor.x > Number.MIN_SAFE_INTEGER &&
      this.cursor.x < Number.MAX_SAFE_INTEGER &&
      transaction.isInterCharacterSpace(this.cursor.x - 1, this.cursor.y) &&
      transaction.isInterCharacterSpace(safeAdd(this.cursor.x, deletedWidth), this.cursor.y);
    this.deleteAndPull(
      transaction,
      this.cursor.x,
      this.cursor.y,
      deletedWidth + (joinsTwoSpaces ? 1 : 0),
    );
    this.commit(transaction, before, this.cursor, null);
  }

  private replaceWithoutCollisions(transaction: Transaction, cells: PlacedCell[], moved: Map<PlacedCell, PlacedCell>, message: string): void {
    const placed = [...moved.values()];
    const fixed = cells.filter((cell) => !moved.has(cell));
    for (let i = 0; i < placed.length; i++) {
      if (fixed.some((cell) => intersects(footprint(cell), cellRect(placed[i]))) || placed.slice(i + 1).some((cell) => intersects(footprint(cell), cellRect(placed[i])))) throw new EditorError(message);
    }
    transaction.replace([...fixed, ...placed]);
  }

  private textLineStart(
    transaction: Transaction,
    referenceX: number,
    y: number,
  ): number {
    if (transaction.scaled) return textRun(transaction.entries(), { x: referenceX, y })[0]?.position.x ?? referenceX;
    let lineStart = referenceX;
    while (
      lineStart > Number.MIN_SAFE_INTEGER &&
      transaction.isTextCell(lineStart - 1, y)
    ) {
      lineStart -= 1;
    }
    return lineStart;
  }

  enter(): void {
    const before = snapshotState(
      this.cursor,
      this.selection,
      this.selectionReflow,
      this.typingStyle,
    );
    const transaction = new Transaction(this.document);
    const selectionStart = this.clearSelectionInTransaction(transaction);
    const cursor = { ...(selectionStart ?? this.cursor) };
    if (transaction.scaled || this.typingStyle.fontSize > 1) {
      const cells = transaction.entries();
      const covered = transaction.anchorAt(cursor.x, cursor.y);
      if (covered && covered.x < cursor.x) cursor.x = safeAdd(covered.x, contentWidth(transaction.read(covered.x, covered.y)!));
      const run = textRun(cells, cursor);
      const lineStart = run[0]?.position.x ?? cursor.x;
      const prefix = run.filter((cell) => cell.position.x < cursor.x);
      const suffix = new Set(run.filter((cell) => cell.position.x >= cursor.x));
      const height = (items: PlacedCell[], fallback: number) => items.length ? Math.max(...items.map((cell) => textHeightInCells(cell.value.style))) : fallback;
      const prefixHeight = height(prefix, textHeightInCells(this.typingStyle));
      const suffixHeight = height([...suffix], textHeightInCells(this.typingStyle));
      const delta = prefixHeight + suffixHeight - height(run, prefixHeight);
      const nextY = safeAdd(cursor.y, prefixHeight);
      const moved = new Map<PlacedCell, PlacedCell>();
      for (const cell of connectedCells(cells, run)) {
        if (suffix.has(cell)) moved.set(cell, moveCell(cell, lineStart - cursor.x, prefixHeight));
        else if (cell.position.y > cursor.y) moved.set(cell, moveCell(cell, 0, delta));
      }
      this.replaceWithoutCollisions(transaction, cells, moved, "다른 문자 블록과 충돌하여 Enter를 적용할 수 없습니다.");
      this.commit(transaction, before, { x: lineStart, y: nextY }, null);
      return;
    }
    if (transaction.get(cursor.x, cursor.y) === "") cursor.x = safeAdd(cursor.x, 1);

    let referenceX: number | null = null;
    if (transaction.isTextCell(cursor.x, cursor.y)) {
      referenceX = cursor.x;
    } else if (
      cursor.x > Number.MIN_SAFE_INTEGER &&
      transaction.isTextCell(cursor.x - 1, cursor.y)
    ) {
      referenceX = cursor.x - 1;
    }

    if (referenceX === null) {
      const next = { x: cursor.x, y: safeAdd(cursor.y, 1) };
      this.commit(transaction, before, next, null);
      return;
    }

    const lineStart = this.textLineStart(transaction, referenceX, cursor.y);
    let lineEnd = referenceX;
    while (
      lineEnd < Number.MAX_SAFE_INTEGER &&
      transaction.isTextCell(lineEnd + 1, cursor.y)
    ) {
      lineEnd += 1;
    }

    const queue: Position[] = [];
    const visited = new Set<string>();
    for (let x = lineStart; x <= lineEnd; x += 1) {
      const key = coordinateKey(x, cursor.y);
      visited.add(key);
      queue.push({ x, y: cursor.y });
      if (x === Number.MAX_SAFE_INTEGER) break;
    }

    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const x = current.x + dx;
          const y = current.y + dy;
          if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) continue;
          const key = coordinateKey(x, y);
          if (visited.has(key) || !transaction.isTextCell(x, y)) continue;
          visited.add(key);
          queue.push({ x, y });
        }
      }
    }

    const moving: Array<{ from: Position; to: Position; value: CellContent }> = [];
    for (const position of queue) {
      const value = transaction.read(position.x, position.y);
      if (value === null) continue;
      if (position.y > cursor.y) {
        moving.push({
          from: position,
          to: { x: position.x, y: safeAdd(position.y, 1) },
          value,
        });
      }
    }
    const suffixStart = Math.max(cursor.x, lineStart);
    for (let x = suffixStart; x <= lineEnd; x += 1) {
      const value = transaction.read(x, cursor.y);
      if (value !== null) {
        moving.push({
          from: { x, y: cursor.y },
          to: {
            x: safeAdd(lineStart, x - cursor.x),
            y: safeAdd(cursor.y, 1),
          },
          value,
        });
      }
      if (x === Number.MAX_SAFE_INTEGER) break;
    }

    const sourceKeys = new Set(
      moving.map((item) => coordinateKey(item.from.x, item.from.y)),
    );
    const destinationKeys = new Set<string>();
    for (const item of moving) {
      const destinationKey = coordinateKey(item.to.x, item.to.y);
      if (destinationKeys.has(destinationKey)) {
        throw new EditorError("Enter 이동 대상이 서로 겹칩니다.");
      }
      destinationKeys.add(destinationKey);
      if (
        transaction.get(item.to.x, item.to.y) !== null &&
        !sourceKeys.has(destinationKey)
      ) {
        throw new EditorError("다른 문자 블록과 충돌하여 Enter를 적용할 수 없습니다.");
      }
    }

    for (const item of moving) transaction.set(item.from.x, item.from.y, null);
    for (const item of moving) transaction.set(item.to.x, item.to.y, item.value);

    this.commit(
      transaction,
      before,
      { x: lineStart, y: safeAdd(cursor.y, 1) },
      null,
    );
  }

  deleteSelection(): void {
    if (!this.selection) return;
    const before = snapshotState(
      this.cursor,
      this.selection,
      this.selectionReflow,
      this.typingStyle,
    );
    const transaction = new Transaction(this.document);
    const start = this.clearSelectionInTransaction(transaction);
    if (start) this.commit(transaction, before, start, null);
  }

  selectionMoveTargetOverlapsText(dx: number, dy: number): boolean {
    const selection = this.selection;
    if (!selection) return false;
    const target = translateSelection(selection, dx, dy);
    let overlaps = false;
    this.document.forEachInSelection(
      target,
      (x, y) => {
        const belongsToSelection =
          isPointInSelection({ x, y }, selection) &&
          this.document.footprint(x, y).width <= selectionRowRange(selection, y).x2 - x &&
          y + this.document.footprint(x, y).height <= selection.y2;
        if (!belongsToSelection) overlaps = true;
      },
    );
    return overlaps;
  }

  private collectTextBlock(
    transaction: Transaction,
    start: Position,
    clearedPath: ReadonlySet<string>,
  ): Map<string, { x: number; y: number; value: CellContent }> {
    if (transaction.get(start.x, start.y) === null) return new Map();
    const block = new Map<string, { x: number; y: number; value: CellContent }>();
    const visited = new Set<string>();
    const queue = [start];

    for (let index = 0; index < queue.length; index += 1) {
      const position = queue[index];
      const key = coordinateKey(position.x, position.y);
      if (visited.has(key)) continue;
      visited.add(key);

      const value = transaction.read(position.x, position.y);
      const isPreservedGap =
        value === null &&
        !clearedPath.has(key) &&
        (transaction.isInterCharacterSpace(position.x, position.y) ||
          transaction.isVerticalBlockGap(position.x, position.y));
      if (value === null && !isPreservedGap) continue;
      if (value !== null) {
        block.set(key, { ...position, value });
      }

      for (let neighborY = -1; neighborY <= 1; neighborY += 1) {
        for (let neighborX = -1; neighborX <= 1; neighborX += 1) {
          if (neighborX === 0 && neighborY === 0) continue;
          const x = position.x + neighborX;
          const y = position.y + neighborY;
          if (Number.isSafeInteger(x) && Number.isSafeInteger(y)) {
            queue.push({ x, y });
          }
        }
      }
    }
    return block;
  }

  private shiftTextBlockOneStep(
    transaction: Transaction,
    moving: Map<string, { x: number; y: number; value: CellContent }>,
    step: Position,
    clearedPath: ReadonlySet<string>,
  ): Map<string, { x: number; y: number; value: CellContent }> {
    const cells = Array.from(moving.values());

    for (let index = 0; index < cells.length; index += 1) {
      const cell = cells[index];
      const destination = {
        x: safeAdd(cell.x, step.x),
        y: safeAdd(cell.y, step.y),
      };
      const destinationKey = coordinateKey(destination.x, destination.y);
      if (
        moving.has(destinationKey) ||
        transaction.get(destination.x, destination.y) === null
      ) {
        continue;
      }
      const collision = this.collectTextBlock(
        transaction,
        destination,
        clearedPath,
      );
      for (const [key, collidedCell] of collision) {
        if (moving.has(key)) continue;
        moving.set(key, collidedCell);
        cells.push(collidedCell);
      }
    }

    const destinations = cells.map((cell) => ({
      x: safeAdd(cell.x, step.x),
      y: safeAdd(cell.y, step.y),
      value: cell.value,
    }));
    for (const cell of cells) transaction.set(cell.x, cell.y, null);
    const shifted = new Map<string, { x: number; y: number; value: CellContent }>();
    for (const destination of destinations) {
      transaction.set(destination.x, destination.y, destination.value);
      shifted.set(coordinateKey(destination.x, destination.y), destination);
    }
    return shifted;
  }

  private pushTextBlockOutOfTarget(
    transaction: Transaction,
    block: Map<string, { x: number; y: number; value: CellContent }>,
    step: Position,
    target: Selection,
    clearedSource: ReadonlySet<string>,
  ): void {
    let moving = block;
    while (
      Array.from(moving.values()).some(
        (cell) => isPointInSelection(cell, target),
      )
    ) {
      moving = this.shiftTextBlockOneStep(
        transaction,
        moving,
        step,
        clearedSource,
      );
    }
  }

  private pushTextOverlappingTarget(
    transaction: Transaction,
    selection: Selection,
    target: Selection,
    pushDirection: Position,
    collisionCells?: ReadonlySet<string>,
  ): void {
    const width = safeAdd(selection.x2, -selection.x1);
    const height = safeAdd(selection.y2, -selection.y1);
    assertTextRasterSize(width, height);

    const clearedSource = new Set<string>();
    for (let y = selection.y1; y < selection.y2; y += 1) {
      for (let x = selection.x1; x < selection.x2; x += 1) {
        if (isPointInSelection({ x, y }, selection)) clearedSource.add(coordinateKey(x, y));
      }
    }

    while (true) {
      let overlap: Position | null = null;
      for (let y = target.y1; y < target.y2; y += 1) {
        for (let x = target.x1; x < target.x2; x += 1) {
          if (isPointInSelection({ x, y }, target) && (!collisionCells || collisionCells.has(coordinateKey(x, y))) && transaction.get(x, y) !== null) {
            overlap ??= { x, y };
            break;
          }
        }
        if (overlap) break;
      }
      if (!overlap) return;
      const block = this.collectTextBlock(
        transaction,
        overlap,
        clearedSource,
      );
      this.pushTextBlockOutOfTarget(
        transaction,
        block,
        pushDirection,
        target,
        clearedSource,
      );
    }
  }

  moveSelection(
    dx: number,
    dy: number,
    options: SelectionMoveOptions = {},
  ): void {
    const selection = this.selection;
    if (!selection || (dx === 0 && dy === 0)) return;
    const target = translateSelection(selection, dx, dy);

    const snapshot: Array<{ x: number; y: number; value: CellContent }> = [];
    this.document.forEachInSelection(
      selection,
      (x, y, text) => snapshot.push({ x, y, value: { text, style: this.document.getStyle(x, y) } }),
      true,
    );
    const targetHasExistingText = this.selectionMoveTargetOverlapsText(dx, dy);

    const before = snapshotState(
      this.cursor,
      this.selection,
      this.selectionReflow,
      this.typingStyle,
    );
    const transaction = new Transaction(this.document);
    if (transaction.scaled) {
      const cells = transaction.entries();
      const moving = cells.filter((cell) => contains(footprint(cell), selection));
      const movingSet = new Set(moving);
      let outside = cells.filter((cell) => !movingSet.has(cell));
      const pushDirection = options.pushDirection ?? cardinalStepBetween(options.lastNonOverlappingOffset ?? { x: 0, y: 0 }, { x: dx, y: dy });
      outside = this.overwriteMode ? outside.filter((cell) => !intersects(footprint(cell), target)) : pushOutside(outside, [target], pushDirection);
      transaction.replace([...outside, ...moving.map((cell) => moveCell(cell, dx, dy))]);
      this.commit(transaction, before, { x: target.x1, y: target.y1 }, target, translateSelectionReflow(this.selectionReflow, dx));
      return;
    }
    this.document.forEachInSelection(
      selection,
      (x, y) => transaction.set(x, y, null),
      true,
    );
    if (!this.overwriteMode && targetHasExistingText) {
      const pushDirection = options.pushDirection ?? cardinalStepBetween(
        options.lastNonOverlappingOffset ?? { x: 0, y: 0 },
        { x: dx, y: dy },
      );
      this.pushTextOverlappingTarget(
        transaction,
        selection,
        target,
        pushDirection,
      );
    } else {
      this.document.forEachInSelection(
        target,
        (x, y) => transaction.set(x, y, null),
      );
    }
    for (const cell of snapshot) {
      transaction.set(safeAdd(cell.x, dx), safeAdd(cell.y, dy), cell.value);
    }
    this.commit(
      transaction,
      before,
      { x: target.x1, y: target.y1 },
      target,
      translateSelectionReflow(this.selectionReflow, dx),
    );
  }

  private captureSelectionReflow(
    transaction: Transaction,
    selection: Selection,
    sourceWidth: number,
  ): SelectionReflow {
    if (transaction.scaled) {
      return { lines: placedContentRows(transaction.entries(), selection).map((row) => {
        const first = row.cells.findIndex((cell) => cell !== null);
        if (first < 0) return { cells: [], lineStartX: selection.x1 };
        const lineStartX = this.textLineStart(transaction, selection.x1 + first, row.y);
        let end = row.cells.length;
        while (end > first && row.cells[end - 1] === null) end--;
        return { cells: row.cells.slice(Math.max(selection.x1, lineStartX) - selection.x1, end), lineStartX };
      }) };
    }
    const lines: Array<{
      cells: ReadonlyArray<CellContent | null>;
      lineStartX: number;
    }> = [];
    let coveredUntil = selection.y1;
    for (let y = selection.y1; y < selection.y2; y += 1) {
      const row: Array<CellContent | null> = [];
      let lastOccupied = -1;
      let firstTextCellX: number | null = null;
      let rowHeight = 1;
      for (let offset = 0; offset < sourceWidth; offset += 1) {
        const x = safeAdd(selection.x1, offset);
        const value = this.selectedRasterCell(transaction, selection, x, y);
        row.push(value);
        if (value) rowHeight = Math.max(rowHeight, textHeightInCells(cellStyle(value)));
        if (value !== null) lastOccupied = offset;
        if (firstTextCellX === null && isPointInSelection({ x, y }, selection) && (value !== null || transaction.isInterCharacterSpace(x, y))) {
          firstTextCellX = x;
        }
      }

      if (lastOccupied < 0 && y < coveredUntil) continue;
      coveredUntil = Math.max(coveredUntil, y + rowHeight);
      if (firstTextCellX === null || lastOccupied < 0) {
        lines.push({ cells: [], lineStartX: selection.x1 });
      } else {
        const lineStartX = this.textLineStart(transaction, firstTextCellX, y);
        const sourceStartX = Math.max(selectionRowRange(selection, y).x1, lineStartX);
        lines.push({
          cells: row.slice(
            safeAdd(sourceStartX, -selection.x1),
            lastOccupied + 1,
          ),
          lineStartX,
        });
      }
      if (y === Number.MAX_SAFE_INTEGER) break;
    }
    return { lines };
  }

  resizeSelectionHorizontal(
    edge: "left" | "right",
    boundaryX: number,
  ): void {
    const selection = this.selection;
    if (!selection) return;
    assertSafePosition({ x: boundaryX, y: selection.y1 });

    const targetX1 = edge === "left" ? boundaryX : selection.x1;
    const targetX2 = edge === "right" ? boundaryX : selection.x2;
    if (targetX2 <= targetX1) {
      throw new EditorError("선택 영역의 너비는 한 칸 이상이어야 합니다.");
    }

    const sourceWidth = safeAdd(selection.x2, -selection.x1);
    const sourceHeight = safeAdd(selection.y2, -selection.y1);
    const targetWidth = safeAdd(targetX2, -targetX1);
    if (this.document.hasScaledText || this.selectionReflow?.lines.some((line) => line.cells.some((cell) => cell && cellStyle(cell).fontSize > 1))) {
      this.resizeScaledSelection(selection, targetX1, targetX2, edge);
      return;
    }
    assertTextRasterSize(sourceWidth, sourceHeight);
    const shrinking = targetWidth < sourceWidth;
    if (targetWidth === sourceWidth) return;

    if (!shrinking && !this.selectionReflow) {
      assertTextRasterSize(targetWidth, sourceHeight);
      this.selection = { ...selection, x1: targetX1, x2: targetX2 };
      this.emit();
      return;
    }

    const transaction = new Transaction(this.document);
    const selectionReflow =
      this.selectionReflow ??
      this.captureSelectionReflow(transaction, selection, sourceWidth);
    const placed: Array<{ x: number; y: number; value: CellContent }> = [];
    const rowLayouts: Array<{ startX: number; usedEndX: number; lineIndex: number }> = [];
    let targetHeight = 0;
    for (const [lineIndex, line] of selectionReflow.lines.entries()) {
      const widest = line.cells.some((value) => value && contentWidth(value) === 2) ? 2 : 1;
      if (targetWidth < widest) {
        throw new EditorError("전각 문자를 포함한 선택 영역의 너비는 두 칸 이상이어야 합니다.");
      }
      const startX = line.lineStartX >= targetX1 && line.lineStartX <= targetX2 - widest ? line.lineStartX : targetX1;
      let x = startX;
      let row = targetHeight;
      rowLayouts[row] = { startX, usedEndX: startX, lineIndex };
      for (const value of line.cells) {
        if (value === "") continue;
        const width = value === null ? 1 : contentWidth(value);
        if (x + width > targetX2) {
          x = startX; row += 1;
          rowLayouts[row] = { startX, usedEndX: startX, lineIndex };
        }
        if (value !== null) placed.push({ x, y: safeAdd(selection.y1, row), value });
        x = safeAdd(x, width);
        rowLayouts[row].usedEndX = x;
      }
      targetHeight = row + 1;
    }
    assertTextRasterSize(targetWidth, targetHeight);
    const target: Selection = {
      x1: targetX1, y1: selection.y1, x2: targetX2,
      y2: safeAdd(selection.y1, targetHeight),
    };

    const before = snapshotState(
      this.cursor,
      selection,
      this.selectionReflow,
      this.typingStyle,
    );
    this.document.forEachInSelection(
      selection,
      (x, y) => transaction.set(x, y, null),
      true,
    );
    if (this.overwriteMode) {
      this.document.forEachInSelection(
        target,
        (x, y) => transaction.set(x, y, null),
      );
    } else {
      const pushDirection = shrinking
        ? { x: 0, y: 1 }
        : { x: edge === "left" ? -1 : 1, y: 0 };
      // Only real glyph footprints collide. Empty space in the selection can adopt text.
      const collisionCells = new Set<string>();
      for (const cell of placed) {
        for (let offset = 0; offset < contentWidth(cell.value); offset += 1) {
          collisionCells.add(coordinateKey(cell.x + offset, cell.y));
        }
      }
      this.pushTextOverlappingTarget(transaction, selection, target, pushDirection, collisionCells);
    }

    let adoptedText = false;
    for (let y = target.y1; y < target.y2; y += 1) {
      for (let x = target.x1; x < target.x2; x += 1) {
        if (this.selectedRasterCell(transaction, target, x, y) !== null) adoptedText = true;
      }
    }
    for (const cell of placed) {
      transaction.set(cell.x, cell.y, cell.value);
      if (contentWidth(cell.value) === 2) transaction.set(cell.x + 1, cell.y, "");
    }
    // Preserve the original logical line boundaries when adopting new text.
    let nextReflow = selectionReflow;
    if (adoptedText) {
      const lines = selectionReflow.lines.map((line) => ({
        cells: [] as Array<CellContent | null>, lineStartX: line.lineStartX,
      }));
      for (const [row, layout] of rowLayouts.entries()) {
        const y = safeAdd(target.y1, row);
        let start = layout.startX;
        let end = layout.usedEndX;
        for (let x = target.x1; x < target.x2; x += 1) {
          if (this.selectedRasterCell(transaction, target, x, y) !== null) {
            start = Math.min(start, x);
            end = Math.max(end, x + 1);
          }
        }
        const line = lines[layout.lineIndex];
        line.lineStartX = Math.min(line.lineStartX, start);
        for (let x = start; x < end; x += 1) line.cells.push(this.selectedRasterCell(transaction, target, x, y));
      }
      nextReflow = { lines };
    }

    this.commit(
      transaction,
      before,
      { x: target.x1, y: target.y1 },
      target,
      nextReflow,
    );
  }

  private resizeScaledSelection(selection: Selection, x1: number, x2: number, edge: "left" | "right"): void {
    const width = x2 - x1;
    const shrinking = width < selection.x2 - selection.x1;
    if (width === selection.x2 - selection.x1) return;
    if (!shrinking && !this.selectionReflow) {
      this.selection = { ...selection, x1, x2 };
      this.emit();
      return;
    }
    const transaction = new Transaction(this.document);
    const reflow = this.selectionReflow ?? this.captureSelectionReflow(transaction, selection, selection.x2 - selection.x1);
    const placed: PlacedCell[] = [];
    const rows: Array<{ y: number; x: number; end: number; line: number }> = [];
    let y = selection.y1;
    for (const [lineIndex, line] of reflow.lines.entries()) {
      const widest = line.cells.reduce((max, cell) => Math.max(max, cell ? contentWidth(cell) : 1), 1);
      if (widest > width) throw new EditorError("선택 너비가 가장 큰 글자보다 좁습니다. 영역을 넓혀 주세요.");
      const start = line.lineStartX >= x1 && line.lineStartX + widest <= x2 ? line.lineStartX : x1;
      let x = start, height = 1;
      for (const value of line.cells) {
        if (value === "") continue;
        const advance = value ? contentWidth(value) : 1;
        if (x + advance > x2) {
          rows.push({ y, x: start, end: x, line: lineIndex });
          y = safeAdd(y, height); x = start; height = 1;
        }
        if (value) {
          placed.push({ position: { x, y }, value: { text: cellText(value), style: cellStyle(value) } });
          height = Math.max(height, textHeightInCells(cellStyle(value)));
        }
        x = safeAdd(x, advance);
      }
      rows.push({ y, x: start, end: x, line: lineIndex });
      y = safeAdd(y, height);
    }
    const target: Selection = { x1, x2, y1: selection.y1, y2: y };
    const before = snapshotState(this.cursor, selection, this.selectionReflow, this.typingStyle);
    let outside = transaction.entries().filter((cell) => !contains(footprint(cell), selection));
    outside = this.overwriteMode ? outside.filter((cell) => !intersects(footprint(cell), target))
      : pushOutside(outside, placed.map(cellRect), shrinking ? { x: 0, y: 1 } : { x: edge === "left" ? -1 : 1, y: 0 });
    const adopted = outside.some((cell) => contains(footprint(cell), target));
    transaction.replace([...outside, ...placed]);
    let nextReflow = reflow;
    if (adopted) {
      const lines = reflow.lines.map((line) => ({ cells: [] as Array<CellContent | null>, lineStartX: line.lineStartX }));
      for (const row of rows) {
        const neighbors = outside.filter((cell) => cell.position.y === row.y && contains(footprint(cell), target));
        const start = Math.min(row.x, ...neighbors.map((cell) => cell.position.x));
        const end = Math.max(row.end, ...neighbors.map((cell) => cell.position.x + contentWidth(cell.value)));
        const line = lines[row.line];
        line.lineStartX = Math.min(line.lineStartX, start);
        for (let x = start; x < end; x++) line.cells.push(this.selectedRasterCell(transaction, target, x, row.y));
      }
      nextReflow = { lines };
    }
    this.commit(transaction, before, { x: x1, y: selection.y1 }, target, nextReflow);
  }

  resizeSelectionVertical(
    edge: "top" | "bottom",
    boundaryY: number,
  ): void {
    const selection = this.selection;
    if (!selection) return;
    assertSafePosition({ x: selection.x1, y: boundaryY });

    const targetY1 = edge === "top" ? boundaryY : selection.y1;
    const targetY2 = edge === "bottom" ? boundaryY : selection.y2;
    if (targetY2 <= targetY1) {
      throw new EditorError("선택 영역의 높이는 한 칸 이상이어야 합니다.");
    }
    if (targetY1 === selection.y1 && targetY2 === selection.y2) return;

    if (selection.rows) {
      const layout = getTextLayout(this.document);
      const bounds = layout.selectionBounds(selection);
      this.selection = layout.selectionForColumns(bounds.x1, bounds.x2, targetY1, targetY2);
    } else this.selection = { ...selection, y1: targetY1, y2: targetY2 };
    this.selectionReflow = null;
    this.emit();
  }

  selectionContent(): Array<Array<CellContent | null>> {
    return this.selection ? contentRows(this.document, this.selection) : [];
  }

  copySelection(): string {
    return this.selectionContent().map((line) => line.map((cell) => cellText(cell ?? " ")).join("")).join("\n");
  }

  search(query: string): SearchResult[] {
    if (query.length === 0 || /[\r\n]| {2}/u.test(query)) {
      this.searchResults = [];
      this.searchIndex = -1;
      this.emit();
      return [];
    }
    const needle = segmentGraphemes(query);
    if (needle.length === 0) return [];
    const cells = Array.from(this.document.entries()).sort(
      (a, b) => a[0].y - b[0].y || a[0].x - b[0].x,
    );
    const results: SearchResult[] = [];
    let run: Array<[Position, string]> = [];

    const searchRun = () => {
      if (run.length < needle.length) return;
      for (let start = 0; start <= run.length - needle.length; start += 1) {
        let matches = true;
        for (let offset = 0; offset < needle.length; offset += 1) {
          if (run[start + offset][1] !== needle[offset]) {
            matches = false;
            break;
          }
        }
        if (matches) results.push({ ...run[start][0] });
      }
    };

    for (const cell of cells) {
      const previousCell = run.at(-1);
      const previous = previousCell?.[0];
      const previousWidth = previousCell ? textWidthInCells(previousCell[1], this.document.getStyle(previousCell[0].x, previousCell[0].y)) : 1;
      if (previous) {
        if (previous.y === cell[0].y && previous.x + previousWidth + 1 === cell[0].x) {
          run.push([
            { x: previous.x + previousWidth, y: previous.y },
            " ",
          ]);
        } else if (
          previous.y !== cell[0].y ||
          previous.x + previousWidth !== cell[0].x
        ) {
          searchRun();
          run = [];
        }
      }
      run.push(cell);
    }
    searchRun();

    this.searchResults = results;
    this.searchIndex = results.length > 0 ? 0 : -1;
    this.emit();
    return results;
  }

  navigateSearch(direction: 1 | -1): SearchResult | null {
    if (this.searchResults.length === 0) return null;
    this.searchIndex =
      (this.searchIndex + direction + this.searchResults.length) %
      this.searchResults.length;
    const result = this.searchResults[this.searchIndex];
    this.cursor = { ...result };
    this.selection = null;
    this.selectionReflow = null;
    this.emit();
    return { ...result };
  }

  addBookmark(name: string): Bookmark {
    const trimmed = name.trim();
    if (!trimmed) throw new EditorError("책갈피 이름을 입력하세요.");
    if (trimmed.length > MAX_BOOKMARK_NAME_LENGTH) {
      throw new EditorError(
        `책갈피 이름은 ${MAX_BOOKMARK_NAME_LENGTH}자 이하여야 합니다.`,
      );
    }
    if (hasControlCharacter(trimmed)) {
      throw new EditorError("책갈피 이름에는 제어 문자를 사용할 수 없습니다.");
    }
    if (this.bookmarks.length >= MAX_BOOKMARKS) {
      throw new EditorError(
        `책갈피는 최대 ${MAX_BOOKMARKS.toLocaleString()}개까지 만들 수 있습니다.`,
      );
    }
    const bookmark: Bookmark = {
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `b-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: trimmed,
      x: this.cursor.x,
      y: this.cursor.y,
    };
    this.bookmarks = [...this.bookmarks, bookmark];
    this.emit("bookmarks");
    return bookmark;
  }

  removeBookmark(id: string): void {
    const next = this.bookmarks.filter((bookmark) => bookmark.id !== id);
    if (next.length === this.bookmarks.length) return;
    this.bookmarks = next;
    this.emit("bookmarks");
  }

  undo(): void {
    const batch = this.undoStack.pop();
    if (!batch) return;
    this.preferredCursorX = null;
    for (const change of batch.changes) {
      this.document.setCell(change.x, change.y, change.before, change.beforeStyle);
    }
    this.cursor = { ...batch.before.cursor };
    this.selection = cloneSelection(batch.before.selection);
    this.selectionReflow = batch.before.selectionReflow;
    this.typingStyle = batch.before.typingStyle;
    this.redoStack.push(batch);
    this.searchResults = [];
    this.searchIndex = -1;
    this.emit("document");
  }

  redo(): void {
    const batch = this.redoStack.pop();
    if (!batch) return;
    this.preferredCursorX = null;
    for (const change of batch.changes) {
      this.document.setCell(change.x, change.y, change.after, change.afterStyle);
    }
    this.cursor = { ...batch.after.cursor };
    this.selection = cloneSelection(batch.after.selection);
    this.selectionReflow = batch.after.selectionReflow;
    this.typingStyle = batch.after.typingStyle;
    this.undoStack.push(batch);
    this.searchResults = [];
    this.searchIndex = -1;
    this.emit("document");
  }

  replaceDocument(
    document: SparseDocument,
    bookmarks: Bookmark[],
    cursor: Position = { x: 0, y: 0 },
  ): void {
    const deletedKeys = this.document.chunkKeys();
    this.document = document;
    this.document.markAllDirty(deletedKeys);
    this.bookmarks = bookmarks.map((bookmark) => ({ ...bookmark }));
    this.cursor = { ...cursor };
    this.selection = null;
    this.selectionReflow = null;
    this.typingStyle = DEFAULT_TEXT_STYLE;
    this.undoStack = [];
    this.redoStack = [];
    this.searchResults = [];
    this.searchIndex = -1;
    this.emit("document");
  }

  loadState(
    document: SparseDocument,
    bookmarks: Bookmark[],
    cursor: Position = { x: 0, y: 0 },
  ): void {
    this.document = document;
    this.bookmarks = bookmarks.map((bookmark) => ({ ...bookmark }));
    this.cursor = { ...cursor };
    this.selection = null;
    this.selectionReflow = null;
    this.typingStyle = DEFAULT_TEXT_STYLE;
    this.undoStack = [];
    this.redoStack = [];
    this.searchResults = [];
    this.searchIndex = -1;
    this.emit();
  }
}
