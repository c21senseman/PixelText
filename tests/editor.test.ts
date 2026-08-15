import assert from "node:assert/strict";
import test from "node:test";
import { chunkAddress, SparseDocument } from "../lib/document";
import { EditorModel } from "../lib/editor";
import { exportJson, importJson } from "../lib/io";

test("negative coordinates use floor-based chunks", () => {
  assert.deepEqual(chunkAddress({ x: -1, y: -1 }), {
    cx: -1,
    cy: -1,
    lx: 63,
    ly: 63,
    index: 4095,
    key: "-1,-1",
  });
  assert.equal(chunkAddress({ x: -64, y: 0 }).key, "-1,0");
  assert.equal(chunkAddress({ x: -65, y: 0 }).key, "-2,0");
});

test("spaces are empty cells and only one-cell gaps between text are spaces", () => {
  const document = new SparseDocument();
  document.setCell(-1, 4, " ");
  assert.equal(document.getCell(-1, 4), null);
  assert.equal(document.cellCount, 0);
  assert.equal(document.chunkCount, 0);

  document.setCell(-2, 4, "A");
  document.setCell(0, 4, "B");
  assert.equal(document.getCell(-1, 4), null);
  assert.equal(document.getTextCell(-1, 4), " ");
  assert.equal(document.isInterCharacterSpace(-1, 4), true);
  assert.equal(document.cellCount, 3);
  assert.equal(document.storedCellCount, 2);

  document.setCell(1, 4, "C");
  assert.equal(document.getTextCell(-1, 4), " ");
  document.deleteCell(0, 4);
  assert.equal(document.getTextCell(-1, 4), null);
  assert.equal(document.cellCount, 2);
});

test("graphemes occupy one cell and insertion preserves a one-cell text gap", () => {
  const editor = new EditorModel();
  editor.insertText("A👨‍👩‍👧‍👦");
  editor.document.setCell(3, 0, "Z");
  editor.setCursor({ x: 1, y: 0 });
  editor.insertText("한");

  assert.equal(editor.document.getCell(0, 0), "A");
  assert.equal(editor.document.getCell(1, 0), "한");
  assert.equal(editor.document.getCell(2, 0), "👨‍👩‍👧‍👦");
  assert.equal(editor.document.getCell(3, 0), null);
  assert.equal(editor.document.getTextCell(3, 0), " ");
  assert.equal(editor.document.getCell(4, 0), "Z");
  assert.deepEqual(editor.cursor, { x: 2, y: 0 });
});

test("backspace and delete pull through a one-cell text gap", () => {
  const editor = new EditorModel();
  editor.insertText("ABCD");
  editor.document.deleteCell(2, 0);
  editor.setCursor({ x: 2, y: 0 });
  editor.backspace();
  assert.equal(editor.document.getCell(0, 0), "A");
  assert.equal(editor.document.getCell(1, 0), null);
  assert.equal(editor.document.getTextCell(1, 0), " ");
  assert.equal(editor.document.getCell(2, 0), "D");
  assert.equal(editor.document.getCell(3, 0), null);
  assert.deepEqual(editor.cursor, { x: 1, y: 0 });

  editor.setCursor({ x: 2, y: 0 });
  editor.deleteForward();
  assert.equal(editor.document.getCell(2, 0), null);
});

test("typed spaces create blanks, keep one separator, and reject repeats", () => {
  const blankEditor = new EditorModel();
  blankEditor.insertText("  ");
  assert.equal(blankEditor.document.cellCount, 0);
  assert.equal(blankEditor.document.chunkCount, 0);
  assert.deepEqual(blankEditor.cursor, { x: 1, y: 0 });

  const editor = new EditorModel();
  editor.insertText("A");
  editor.insertText(" ");

  assert.equal(editor.document.getCell(1, 0), null);
  assert.equal(editor.document.cellCount, 1);
  assert.deepEqual(editor.cursor, { x: 2, y: 0 });

  editor.insertText(" ");
  assert.deepEqual(editor.cursor, { x: 2, y: 0 });

  editor.insertText("B");
  assert.equal(editor.document.getCell(2, 0), "B");
  assert.equal(editor.document.getTextCell(1, 0), " ");
  assert.equal(editor.document.cellCount, 3);
  assert.deepEqual(editor.search("A B"), [{ x: 0, y: 0 }]);
  assert.deepEqual(editor.search("A  B"), []);
});

test("pasted repeated spaces are reduced to one empty separator cell", () => {
  const editor = new EditorModel();
  editor.insertText("A  B");

  assert.equal(editor.document.getCell(0, 0), "A");
  assert.equal(editor.document.getCell(1, 0), null);
  assert.equal(editor.document.getCell(2, 0), "B");
  assert.equal(editor.document.getCell(3, 0), null);
  assert.equal(editor.document.cellCount, 3);
  assert.deepEqual(editor.cursor, { x: 3, y: 0 });
});

test("editing an existing separator never creates a double space", () => {
  const editor = new EditorModel();
  editor.insertText("A B C");
  editor.setCursor({ x: 2, y: 0 });
  editor.deleteForward();

  assert.equal(editor.document.getCell(0, 0), "A");
  assert.equal(editor.document.getTextCell(1, 0), " ");
  assert.equal(editor.document.getCell(2, 0), "C");
  assert.equal(editor.document.getCell(3, 0), null);
  assert.deepEqual(editor.search("A C"), [{ x: 0, y: 0 }]);

  editor.setCursor({ x: 1, y: 0 });
  editor.insertText(" ");
  assert.deepEqual(editor.cursor, { x: 2, y: 0 });
  assert.deepEqual(editor.search("A C"), [{ x: 0, y: 0 }]);
});

test("multiline paste inserts each row independently", () => {
  const editor = new EditorModel();
  editor.document.setCell(0, 0, "X");
  editor.document.setCell(0, 1, "Y");
  editor.setCursor({ x: 0, y: 0 });
  editor.insertText("AB\n\n한");

  assert.equal(editor.document.getCell(0, 0), "A");
  assert.equal(editor.document.getCell(1, 0), "B");
  assert.equal(editor.document.getCell(2, 0), "X");
  assert.equal(editor.document.getCell(0, 1), "Y");
  assert.equal(editor.document.getCell(0, 2), "한");
  assert.deepEqual(editor.cursor, { x: 1, y: 2 });
});

test("Enter splits a line and moves its connected lower block", () => {
  const editor = new EditorModel();
  editor.insertText("abcdef");
  editor.setCursor({ x: 0, y: 1 });
  editor.insertText("hello");
  editor.setCursor({ x: 3, y: 0 });
  editor.enter();

  assert.equal(editor.document.getCell(0, 0), "a");
  assert.equal(editor.document.getCell(2, 0), "c");
  assert.equal(editor.document.getCell(3, 0), null);
  assert.equal(editor.document.getCell(0, 1), "d");
  assert.equal(editor.document.getCell(2, 1), "f");
  assert.equal(editor.document.getCell(0, 2), "h");
  assert.equal(editor.document.getCell(4, 2), "o");
  assert.deepEqual(editor.cursor, { x: 0, y: 1 });
});

test("selection deletion and undo restore cells, cursor, and selection", () => {
  const editor = new EditorModel();
  editor.insertText("ABC");
  editor.setSelection({ x1: 1, y1: 0, x2: 3, y2: 1 });
  editor.deleteSelection();
  assert.equal(editor.document.getCell(1, 0), null);
  assert.equal(editor.document.getCell(2, 0), null);
  assert.deepEqual(editor.cursor, { x: 1, y: 0 });

  editor.undo();
  assert.equal(editor.document.getCell(1, 0), "B");
  assert.equal(editor.document.getCell(2, 0), "C");
  assert.deepEqual(editor.selection, { x1: 1, y1: 0, x2: 3, y2: 1 });
  editor.redo();
  assert.equal(editor.document.getCell(1, 0), null);
});

test("arrow keys clear a rectangular selection and move from the current cursor", () => {
  const editor = new EditorModel();
  editor.setCursor({ x: 4, y: 3 });
  editor.setSelection({ x1: 2, y1: 1, x2: 8, y2: 6 });
  editor.moveCursor(1, 0);
  assert.deepEqual(editor.cursor, { x: 5, y: 3 });
  assert.equal(editor.selection, null);

  editor.setSelection({ x1: 2, y1: 1, x2: 8, y2: 6 });
  editor.moveCursor(0, -1);
  assert.deepEqual(editor.cursor, { x: 5, y: 2 });
  assert.equal(editor.selection, null);
});

test("moving an overlapping rectangular selection uses a snapshot", () => {
  const editor = new EditorModel();
  editor.insertText("ABC");
  editor.setSelection({ x1: 0, y1: 0, x2: 3, y2: 1 });
  editor.moveSelection(1, 0);
  assert.equal(editor.document.getCell(0, 0), null);
  assert.equal(editor.document.getCell(1, 0), "A");
  assert.equal(editor.document.getCell(2, 0), "B");
  assert.equal(editor.document.getCell(3, 0), "C");
  assert.deepEqual(editor.selection, { x1: 1, y1: 0, x2: 4, y2: 1 });
});

test("copy preserves empty cells and search includes one-cell separators", () => {
  const editor = new EditorModel();
  editor.document.setCell(0, 0, "A");
  editor.document.setCell(2, 0, "B");
  editor.document.setCell(0, 1, "C");
  editor.setSelection({ x1: 0, y1: 0, x2: 3, y2: 2 });
  assert.equal(editor.copySelection(), "A B\nC  ");
  assert.deepEqual(editor.search("A B"), [{ x: 0, y: 0 }]);
  assert.deepEqual(editor.search("BC"), []);
});

test("JSON export is deterministic and import validates atomically", () => {
  const document = new SparseDocument();
  document.setCell(64, 0, "B");
  document.setCell(-1, 0, "A");
  const raw = exportJson(document, [], { x: 3, y: -2, zoom: 1.25 });
  const parsed = JSON.parse(raw);
  assert.deepEqual(
    parsed.chunks.map((chunk: { x: number; y: number }) => [chunk.x, chunk.y]),
    [[-1, 0], [1, 0]],
  );

  const imported = importJson(raw);
  assert.equal(imported.document.getCell(-1, 0), "A");
  assert.equal(imported.document.getCell(64, 0), "B");
  assert.deepEqual(imported.camera, { x: 3, y: -2, zoom: 1.25 });

  parsed.chunks[0].cells.push(parsed.chunks[0].cells[0]);
  assert.throws(() => importJson(JSON.stringify(parsed)), /중복/);
});

test("legacy JSON space cells load as empty cells", () => {
  const raw = JSON.stringify({
    version: 1,
    chunkSize: 64,
    chunks: [{ x: 0, y: 0, cells: [[0, "A"], [1, " "], [2, "B"]] }],
    bookmarks: [],
    camera: { x: 0, y: 0, zoom: 1 },
  });
  const imported = importJson(raw);

  assert.equal(imported.document.getCell(1, 0), null);
  assert.equal(imported.document.getTextCell(1, 0), " ");
  assert.equal(imported.document.cellCount, 3);
  assert.equal(imported.document.storedCellCount, 2);
  assert.doesNotMatch(
    exportJson(imported.document, [], { x: 0, y: 0, zoom: 1 }),
    /\[\s*1,\s*" "\s*\]/u,
  );
});
