import { SparseDocument } from "./document";
import { getTextLayout } from "./layout";
import { BASE_FONT_SIZE, DEFAULT_TEXT_STYLE, cellStyle, cellText, parseTextStyle, sameStyle, type CellContent, type FormattingState, type StyleToggle, type TextStyle } from "./formatting";
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

  constructor(private readonly document: SparseDocument) {}

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
    return null;
  }

  set(x: number, y: number, content: CellContent | null): void {
    assertSafePosition({ x, y });
    const after = content === null ? null : cellText(content);
    const nextValue = after === " " ? null : after;
    const afterStyle = nextValue && content ? cellStyle(content) : DEFAULT_TEXT_STYLE;
    const key = coordinateKey(x, y);
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
    if (dx === 0 && dy !== 0) {
      const layout = getTextLayout(this.document);
      const preferred = this.preferredCursorX ?? layout.toWorld(this.cursor).x;
      const y = safeAdd(this.cursor.y, dy);
      this.setCursor({ x: layout.nearestCursorX(preferred, y), y });
      this.preferredCursorX = preferred;
      return;
    }
    let x = safeAdd(this.cursor.x, dx);
    const y = safeAdd(this.cursor.y, dy);
    if (dx > 0 && dy === 0 && this.document.getRasterCell(x, y) === "") {
      x = safeAdd(x, 1);
    }
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
    if (value === "" && x === range.x1) return null;
    if (value && graphemeWidth(cellText(value)) > range.x2 - x) return null;
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
        assertSafePosition({ x: change.x + (graphemeWidth(change.after) - 1), y: change.y });
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
    const width = graphemeWidth(grapheme);
    const nextCursor = { x: safeAdd(position.x, width), y: position.y };
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
    if (width === 2) transaction.set(position.x + 1, position.y, "");
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
    const width = graphemeWidth(grapheme);
    const nextCursor = { x: safeAdd(position.x, width), y: position.y };
    for (let x = position.x; x < nextCursor.x; x += 1) {
      if (transaction.get(x, position.y) === "") transaction.set(x - 1, position.y, null);
      transaction.set(x, position.y, null);
    }
    transaction.set(position.x, position.y, { text: grapheme, style });
    if (width === 2) transaction.set(position.x + 1, position.y, "");
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
        return sum + graphemeWidth(cellText(value));
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
    if (transaction.get(start.x, start.y) === "") start.x = safeAdd(start.x, 1);
    let finalCursor = { ...start };
    let textIndex = 0;
    let lastStyle: TextStyle = inputStyle;

    for (let row = 0; row < segmentedLines.length; row += 1) {
      const y = safeAdd(start.y, row);
      let lineCursor: Position = { x: start.x, y };
      for (const grapheme of segmentedLines[row]) {
        lastStyle = styles?.get(textIndex) ?? (styles ? DEFAULT_TEXT_STYLE : inputStyle);
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
    }

    this.commit(transaction, before, finalCursor, null, null, lastStyle);
  }

  private deleteAndPull(
    transaction: Transaction,
    startX: number,
    y: number,
    width: number,
  ): void {
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
    const targetX = transaction.get(this.cursor.x - 1, this.cursor.y) === ""
      ? this.cursor.x - 2 : this.cursor.x - 1;
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
    const deletedWidth = graphemeWidth(transaction.get(this.cursor.x, this.cursor.y) ?? " ");
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

  private textLineStart(
    transaction: Transaction,
    referenceX: number,
    y: number,
  ): number {
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
      (x, y, value) => {
        const belongsToSelection =
          isPointInSelection({ x, y }, selection) &&
          graphemeWidth(value) <= selectionRowRange(selection, y).x2 - x;
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
    const lines: Array<{
      cells: ReadonlyArray<CellContent | null>;
      lineStartX: number;
    }> = [];
    for (let y = selection.y1; y < selection.y2; y += 1) {
      const row: Array<CellContent | null> = [];
      let lastOccupied = -1;
      let firstTextCellX: number | null = null;
      for (let offset = 0; offset < sourceWidth; offset += 1) {
        const x = safeAdd(selection.x1, offset);
        const value = this.selectedRasterCell(transaction, selection, x, y);
        row.push(value);
        if (value !== null) lastOccupied = offset;
        if (firstTextCellX === null && isPointInSelection({ x, y }, selection) && (value !== null || transaction.isInterCharacterSpace(x, y))) {
          firstTextCellX = x;
        }
      }

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
    worldBoundary?: number,
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
    assertTextRasterSize(sourceWidth, sourceHeight);
    const layout = getTextLayout(this.document);
    const sourceBounds = layout.selectionBounds(selection);
    let visualReflow = !!selection.rows;
    this.document.forEachInSelection(selection, (x, y) => {
      if (this.document.getStyle(x, y).fontSize !== BASE_FONT_SIZE) visualReflow = true;
    }, true);
    const boundary = worldBoundary ?? layout.toWorld({ x: boundaryX, y: selection.y1 }).x;
    const left = edge === "left" ? boundary : sourceBounds.x1;
    const right = edge === "right" ? boundary : sourceBounds.x2;
    const visualWidth = right - left;
    if (!Number.isFinite(visualWidth) || visualWidth <= 0) throw new EditorError("선택 영역의 너비는 양수여야 합니다.");
    const shrinking = visualReflow ? visualWidth < sourceBounds.x2 - sourceBounds.x1 - 1e-9 : targetWidth < sourceWidth;
    const unchanged = visualReflow ? Math.abs(visualWidth - (sourceBounds.x2 - sourceBounds.x1)) < 1e-9 : targetWidth === sourceWidth;

    if (unchanged) return;

    if (!shrinking && !this.selectionReflow) {
      assertTextRasterSize(targetWidth, sourceHeight);
      this.selection = visualReflow ? layout.selectionForColumns(left, right, selection.y1, selection.y2)
        : { ...selection, x1: targetX1, x2: targetX2 };
      this.emit();
      return;
    }

    const transaction = new Transaction(this.document);
    const selectionReflow =
      this.selectionReflow ??
      this.captureSelectionReflow(transaction, selection, sourceWidth);
    const placed: Array<{ x: number; y: number; value: CellContent }> = [];
    const rowLayouts: Array<{ startX: number; usedEndX: number; lineIndex: number; remaining: number }> = [];
    let targetHeight = 0;
    for (const [lineIndex, line] of selectionReflow.lines.entries()) {
      const widest = line.cells.some((value) => value && graphemeWidth(cellText(value)) === 2) ? 2 : 1;
      const widestVisual = line.cells.reduce((max, value) => Math.max(max, value ? graphemeWidth(cellText(value)) * cellStyle(value).fontSize / BASE_FONT_SIZE : 0), 0);
      if (visualReflow && widestVisual > visualWidth + 1e-9) throw new EditorError("선택 너비가 가장 큰 글자보다 좁습니다. 글자 크기를 줄이거나 영역을 넓혀 주세요.");
      if (!visualReflow && targetWidth < widest) {
        throw new EditorError("전각 문자를 포함한 선택 영역의 너비는 두 칸 이상이어야 합니다.");
      }
      const startX = line.lineStartX >= targetX1 && line.lineStartX <= targetX2 - widest &&
        (!visualReflow || line.lineStartX - targetX1 + widestVisual <= visualWidth)
        ? line.lineStartX : targetX1;
      let x = startX;
      let row = targetHeight;
      const available = visualWidth - (startX - targetX1);
      let used = 0;
      let previousScale = 1;
      rowLayouts[row] = { startX, usedEndX: startX, lineIndex, remaining: available };
      for (const [index, value] of line.cells.entries()) {
        if (value === "") continue;
        const width = value === null ? 1 : graphemeWidth(cellText(value));
        const scale = value ? cellStyle(value).fontSize / BASE_FONT_SIZE
          : (line.cells[index + 1] ? previousScale : 1);
        const advance = width * scale;
        if (visualReflow ? used > 0 && used + advance > available + 1e-9 : x + width > targetX2) {
          x = startX; row += 1;
          used = 0;
          rowLayouts[row] = { startX, usedEndX: startX, lineIndex, remaining: available };
        }
        if (value !== null) placed.push({ x, y: safeAdd(selection.y1, row), value });
        x = safeAdd(x, width);
        used += advance;
        previousScale = value ? scale : 1;
        rowLayouts[row].usedEndX = x;
        rowLayouts[row].remaining = Math.max(0, available - used);
      }
      targetHeight = row + 1;
    }
    assertTextRasterSize(targetWidth, targetHeight);
    let target: Selection = {
      x1: targetX1, y1: selection.y1, x2: targetX2,
      y2: safeAdd(selection.y1, targetHeight),
    };
    if (visualReflow) {
      const rows = rowLayouts.map((row, index) => ({ y: safeAdd(selection.y1, index), x1: targetX1,
        x2: safeAdd(row.usedEndX, Math.floor(row.remaining + 1e-9)) }));
      let maxX = targetX1 + 1;
      for (const row of rows) maxX = Math.max(maxX, row.x2);
      target = { ...target, x2: maxX, rows };
      assertTextRasterSize(target.x2 - target.x1, targetHeight);
    }

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
        for (let offset = 0; offset < graphemeWidth(cellText(cell.value)); offset += 1) {
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
      if (graphemeWidth(cellText(cell.value)) === 2) transaction.set(cell.x + 1, cell.y, "");
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

  copySelection(): string {
    const selection = this.selection;
    if (!selection) return "";
    const width = selection.x2 - selection.x1;
    const height = selection.y2 - selection.y1;
    assertTextRasterSize(width, height);
    const lines: string[] = [];
    const transaction = new Transaction(this.document);
    for (let y = selection.y1; y < selection.y2; y += 1) {
      let line = "";
      const range = selectionRowRange(selection, y);
      for (let x = range.x1; x < range.x2; x += 1) {
        line += cellText(this.selectedRasterCell(transaction, selection, x, y) ?? " ");
      }
      lines.push(line);
    }
    return lines.join("\n");
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
      const previousWidth = previousCell ? graphemeWidth(previousCell[1]) : 1;
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
