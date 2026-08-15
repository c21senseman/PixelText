import { SparseDocument } from "./document";
import { normalizeTextInput, segmentGraphemes } from "./graphemes";
import {
  Bookmark,
  Change,
  EditorError,
  EditorSnapshot,
  HistoryBatch,
  Position,
  SearchResult,
  Selection,
  assertSafePosition,
  assertTextRasterSize,
  cloneSelection,
  normalizeSelection,
  safeAdd,
} from "./types";

const HISTORY_LIMIT = 500;

function coordinateKey(x: number, y: number): string {
  return `${x},${y}`;
}

function snapshotState(
  cursor: Position,
  selection: Selection | null,
): EditorSnapshot {
  return { cursor: { ...cursor }, selection: cloneSelection(selection) };
}

class Transaction {
  private readonly changes = new Map<string, Change>();

  constructor(private readonly document: SparseDocument) {}

  get(x: number, y: number): string | null {
    assertSafePosition({ x, y });
    const pending = this.changes.get(coordinateKey(x, y));
    return pending ? pending.after : this.document.getCell(x, y);
  }

  set(x: number, y: number, after: string | null): void {
    assertSafePosition({ x, y });
    const nextValue = after === " " ? null : after;
    const key = coordinateKey(x, y);
    const existing = this.changes.get(key);
    if (existing) {
      existing.after = nextValue;
      return;
    }
    this.changes.set(key, {
      x,
      y,
      before: this.document.getCell(x, y),
      after: nextValue,
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

  isTextCell(x: number, y: number): boolean {
    return this.get(x, y) !== null || this.isInterCharacterSpace(x, y);
  }

  finalChanges(): Change[] {
    return Array.from(this.changes.values()).filter(
      (change) => change.before !== change.after,
    );
  }
}

export type EditorListener = () => void;

export class EditorModel {
  document: SparseDocument;
  cursor: Position = { x: 0, y: 0 };
  selection: Selection | null = null;
  bookmarks: Bookmark[] = [];
  searchResults: SearchResult[] = [];
  searchIndex = -1;

  private undoStack: HistoryBatch[] = [];
  private redoStack: HistoryBatch[] = [];
  private readonly listeners = new Set<EditorListener>();

  constructor(document = new SparseDocument()) {
    this.document = document;
  }

  subscribe(listener: EditorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  setCursor(position: Position, clearSelection = true): void {
    assertSafePosition(position);
    this.cursor = { ...position };
    if (clearSelection) this.selection = null;
    this.emit();
  }

  moveCursor(dx: number, dy: number): void {
    this.setCursor({
      x: safeAdd(this.cursor.x, dx),
      y: safeAdd(this.cursor.y, dy),
    });
  }

  setSelection(selection: Selection | null): void {
    if (!selection) {
      this.selection = null;
      this.emit();
      return;
    }
    const normalized = normalizeSelection(selection);
    assertSafePosition({ x: normalized.x1, y: normalized.y1 });
    assertSafePosition({ x: normalized.x2, y: normalized.y2 });
    this.selection =
      normalized.x1 === normalized.x2 || normalized.y1 === normalized.y2
        ? null
        : normalized;
    this.emit();
  }

  private clearSelectionInTransaction(transaction: Transaction): Position | null {
    const selection = this.selection;
    if (!selection) return null;
    this.document.forEachInRect(
      selection.x1,
      selection.y1,
      selection.x2,
      selection.y2,
      (x, y) => transaction.set(x, y, null),
    );
    return { x: selection.x1, y: selection.y1 };
  }

  private clearSelectionAndPullLeft(
    transaction: Transaction,
    selection: Selection,
  ): Position {
    const width = safeAdd(selection.x2, -selection.x1);
    const moving: Array<{
      fromX: number;
      toX: number;
      y: number;
      value: string;
    }> = [];

    for (let y = selection.y1; y < selection.y2; y += 1) {
      let x = selection.x2;
      while (transaction.isTextCell(x, y)) {
        const value = transaction.get(x, y);
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
    return { x: selection.x1, y: selection.y1 };
  }

  private commit(
    transaction: Transaction,
    before: EditorSnapshot,
    cursor: Position,
    selection: Selection | null,
  ): void {
    assertSafePosition(cursor);
    const changes = transaction.finalChanges();
    for (const change of changes) {
      this.document.setCell(change.x, change.y, change.after);
    }
    this.cursor = { ...cursor };
    this.selection = cloneSelection(selection);

    if (changes.length > 0) {
      this.undoStack.push({
        changes,
        before,
        after: snapshotState(this.cursor, this.selection),
      });
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this.searchResults = [];
      this.searchIndex = -1;
    }
    this.emit();
  }

  private insertOne(
    transaction: Transaction,
    position: Position,
    grapheme: string,
  ): Position {
    const nextCursor = { x: safeAdd(position.x, 1), y: position.y };
    let end = position.x;
    while (transaction.isTextCell(end, position.y)) {
      end = safeAdd(end, 1);
    }
    for (let x = end; x > position.x; x -= 1) {
      transaction.set(x, position.y, transaction.get(x - 1, position.y));
    }
    transaction.set(position.x, position.y, grapheme);
    return nextCursor;
  }

  private insertBlank(
    transaction: Transaction,
    position: Position,
  ): Position {
    if (transaction.isInterCharacterSpace(position.x, position.y)) {
      return { x: safeAdd(position.x, 1), y: position.y };
    }

    const nextCursor = { x: safeAdd(position.x, 1), y: position.y };
    let end = position.x;
    while (transaction.isTextCell(end, position.y)) {
      end = safeAdd(end, 1);
    }
    for (let x = end; x > position.x; x -= 1) {
      transaction.set(x, position.y, transaction.get(x - 1, position.y));
    }
    transaction.set(position.x, position.y, null);
    return nextCursor;
  }

  insertText(rawText: string): void {
    const text = normalizeTextInput(rawText);
    if (text.length === 0) return;
    const lines = text.split("\n");
    const segmentedLines = lines.map((line) => segmentGraphemes(line));
    const width = segmentedLines.reduce(
      (maximum, line) => Math.max(maximum, line.length),
      0,
    );
    assertTextRasterSize(width, segmentedLines.length);
    const before = snapshotState(this.cursor, this.selection);
    const transaction = new Transaction(this.document);
    const selectionStart = this.clearSelectionInTransaction(transaction);
    const start = selectionStart ?? this.cursor;
    let finalCursor = { ...start };

    for (let row = 0; row < segmentedLines.length; row += 1) {
      const y = safeAdd(start.y, row);
      let lineCursor: Position = { x: start.x, y };
      for (const grapheme of segmentedLines[row]) {
        if (grapheme === " ") {
          lineCursor = this.insertBlank(transaction, lineCursor);
        } else {
          lineCursor = this.insertOne(transaction, lineCursor, grapheme);
        }
      }
      finalCursor = lineCursor;
    }

    this.commit(transaction, before, finalCursor, null);
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

    for (let x = startX; x <= lastX; x += 1) {
      const sourceX = x <= Number.MAX_SAFE_INTEGER - width ? x + width : null;
      transaction.set(
        x,
        y,
        sourceX !== null && sourceX <= lastX
          ? transaction.get(sourceX, y)
          : null,
      );
      if (x === Number.MAX_SAFE_INTEGER) break;
    }
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
      transaction.set(sourceX - 1, y, transaction.get(sourceX, y));
      if (sourceX === Number.MAX_SAFE_INTEGER) break;
    }
    transaction.set(endX, y, null);
  }

  private cursorAfterPreviousLine(
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
    return { x, y: previousY };
  }

  backspace(): void {
    const before = snapshotState(this.cursor, this.selection);
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

    const previousLineCursor = this.cursorAfterPreviousLine(
      transaction,
      this.cursor,
    );
    if (previousLineCursor) {
      this.commit(transaction, before, previousLineCursor, null);
      return;
    }

    if (this.cursor.x === Number.MIN_SAFE_INTEGER) return;
    const targetX = this.cursor.x - 1;
    if (transaction.isTextCell(targetX, this.cursor.y)) {
      const joinsTwoSpaces =
        transaction.get(targetX, this.cursor.y) !== null &&
        targetX > Number.MIN_SAFE_INTEGER &&
        targetX < Number.MAX_SAFE_INTEGER &&
        transaction.isInterCharacterSpace(targetX - 1, this.cursor.y) &&
        transaction.isInterCharacterSpace(targetX + 1, this.cursor.y);
      this.deleteAndPull(
        transaction,
        targetX,
        this.cursor.y,
        joinsTwoSpaces ? 2 : 1,
      );
    } else if (transaction.get(this.cursor.x, this.cursor.y) !== null) {
      this.pullTextRunLeft(transaction, this.cursor.x, this.cursor.y);
    }
    this.commit(transaction, before, { x: targetX, y: this.cursor.y }, null);
  }

  deleteForward(): void {
    const before = snapshotState(this.cursor, this.selection);
    const transaction = new Transaction(this.document);
    const selectionStart = this.clearSelectionInTransaction(transaction);
    if (selectionStart) {
      this.commit(transaction, before, selectionStart, null);
      return;
    }

    if (!transaction.isTextCell(this.cursor.x, this.cursor.y)) return;
    const joinsTwoSpaces =
      transaction.get(this.cursor.x, this.cursor.y) !== null &&
      this.cursor.x > Number.MIN_SAFE_INTEGER &&
      this.cursor.x < Number.MAX_SAFE_INTEGER &&
      transaction.isInterCharacterSpace(this.cursor.x - 1, this.cursor.y) &&
      transaction.isInterCharacterSpace(this.cursor.x + 1, this.cursor.y);
    this.deleteAndPull(
      transaction,
      this.cursor.x,
      this.cursor.y,
      joinsTwoSpaces ? 2 : 1,
    );
    this.commit(transaction, before, this.cursor, null);
  }

  enter(): void {
    const before = snapshotState(this.cursor, this.selection);
    const transaction = new Transaction(this.document);
    const selectionStart = this.clearSelectionInTransaction(transaction);
    const cursor = selectionStart ?? this.cursor;

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

    let lineStart = referenceX;
    while (
      lineStart > Number.MIN_SAFE_INTEGER &&
      transaction.isTextCell(lineStart - 1, cursor.y)
    ) {
      lineStart -= 1;
    }
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

    const moving: Array<{ from: Position; to: Position; value: string }> = [];
    for (const position of queue) {
      const value = transaction.get(position.x, position.y);
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
      const value = transaction.get(x, cursor.y);
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
    const before = snapshotState(this.cursor, this.selection);
    const transaction = new Transaction(this.document);
    const start = this.clearSelectionInTransaction(transaction);
    if (start) this.commit(transaction, before, start, null);
  }

  moveSelection(dx: number, dy: number): void {
    const selection = this.selection;
    if (!selection || (dx === 0 && dy === 0)) return;
    const target: Selection = {
      x1: safeAdd(selection.x1, dx),
      y1: safeAdd(selection.y1, dy),
      x2: safeAdd(selection.x2, dx),
      y2: safeAdd(selection.y2, dy),
    };

    const snapshot: Array<{ x: number; y: number; value: string }> = [];
    this.document.forEachInRect(
      selection.x1,
      selection.y1,
      selection.x2,
      selection.y2,
      (x, y, value) => snapshot.push({ x, y, value }),
    );

    const before = snapshotState(this.cursor, this.selection);
    const transaction = new Transaction(this.document);
    this.document.forEachInRect(
      selection.x1,
      selection.y1,
      selection.x2,
      selection.y2,
      (x, y) => transaction.set(x, y, null),
    );
    this.document.forEachInRect(
      target.x1,
      target.y1,
      target.x2,
      target.y2,
      (x, y) => transaction.set(x, y, null),
    );
    for (const cell of snapshot) {
      transaction.set(safeAdd(cell.x, dx), safeAdd(cell.y, dy), cell.value);
    }
    this.commit(transaction, before, { x: target.x1, y: target.y1 }, target);
  }

  copySelection(): string {
    const selection = this.selection;
    if (!selection) return "";
    const width = selection.x2 - selection.x1;
    const height = selection.y2 - selection.y1;
    assertTextRasterSize(width, height);
    const lines: string[] = [];
    for (let y = selection.y1; y < selection.y2; y += 1) {
      let line = "";
      for (let x = selection.x1; x < selection.x2; x += 1) {
        line += this.document.getCell(x, y) ?? " ";
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
      const previous = run.at(-1)?.[0];
      if (previous) {
        if (previous.y === cell[0].y && previous.x + 2 === cell[0].x) {
          run.push([
            { x: previous.x + 1, y: previous.y },
            " ",
          ]);
        } else if (
          previous.y !== cell[0].y ||
          previous.x + 1 !== cell[0].x
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
    this.emit();
    return { ...result };
  }

  addBookmark(name: string): Bookmark {
    const trimmed = name.trim();
    if (!trimmed) throw new EditorError("책갈피 이름을 입력하세요.");
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
    this.emit();
    return bookmark;
  }

  removeBookmark(id: string): void {
    const next = this.bookmarks.filter((bookmark) => bookmark.id !== id);
    if (next.length === this.bookmarks.length) return;
    this.bookmarks = next;
    this.emit();
  }

  undo(): void {
    const batch = this.undoStack.pop();
    if (!batch) return;
    for (const change of batch.changes) {
      this.document.setCell(change.x, change.y, change.before);
    }
    this.cursor = { ...batch.before.cursor };
    this.selection = cloneSelection(batch.before.selection);
    this.redoStack.push(batch);
    this.searchResults = [];
    this.searchIndex = -1;
    this.emit();
  }

  redo(): void {
    const batch = this.redoStack.pop();
    if (!batch) return;
    for (const change of batch.changes) {
      this.document.setCell(change.x, change.y, change.after);
    }
    this.cursor = { ...batch.after.cursor };
    this.selection = cloneSelection(batch.after.selection);
    this.undoStack.push(batch);
    this.searchResults = [];
    this.searchIndex = -1;
    this.emit();
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
    this.undoStack = [];
    this.redoStack = [];
    this.searchResults = [];
    this.searchIndex = -1;
    this.emit();
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
    this.undoStack = [];
    this.redoStack = [];
    this.searchResults = [];
    this.searchIndex = -1;
    this.emit();
  }
}
