import assert from "node:assert/strict";
import test from "node:test";
import { chunkAddress, SparseDocument } from "../lib/document";
import { EditorModel } from "../lib/editor";
import { exportJson, importJson } from "../lib/io";
import {
  MIN_ZOOM,
  selectionAutoPanVelocity,
  selectionFromCursorDrag,
} from "../lib/types";

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

test("backspace at a character's left edge pulls its text run left", () => {
  const editor = new EditorModel();
  editor.insertText("A  BC");
  editor.setCursor({ x: 3, y: 0 });

  editor.backspace();
  assert.equal(editor.document.getCell(0, 0), "A");
  assert.equal(editor.document.getCell(1, 0), null);
  assert.equal(editor.document.getCell(2, 0), "B");
  assert.equal(editor.document.getCell(3, 0), "C");
  assert.equal(editor.document.getCell(4, 0), null);
  assert.deepEqual(editor.cursor, { x: 2, y: 0 });

  editor.backspace();
  assert.equal(editor.document.getCell(0, 0), "A");
  assert.equal(editor.document.getCell(1, 0), "B");
  assert.equal(editor.document.getCell(2, 0), "C");
  assert.equal(editor.document.getCell(3, 0), null);
  assert.deepEqual(editor.cursor, { x: 1, y: 0 });

  editor.undo();
  assert.equal(editor.document.getCell(1, 0), null);
  assert.equal(editor.document.getCell(2, 0), "B");
  assert.equal(editor.document.getCell(3, 0), "C");
  assert.deepEqual(editor.cursor, { x: 2, y: 0 });
});

test("each typed space advances through empty cells", () => {
  const blankEditor = new EditorModel();
  blankEditor.insertText(" ");
  blankEditor.insertText(" ");
  blankEditor.insertText(" ");
  assert.equal(blankEditor.document.cellCount, 0);
  assert.equal(blankEditor.document.chunkCount, 0);
  assert.deepEqual(blankEditor.cursor, { x: 3, y: 0 });

  const editor = new EditorModel();
  editor.insertText("A");
  editor.insertText(" ");

  assert.equal(editor.document.getCell(1, 0), null);
  assert.equal(editor.document.cellCount, 1);
  assert.deepEqual(editor.cursor, { x: 2, y: 0 });

  editor.insertText(" ");
  assert.deepEqual(editor.cursor, { x: 3, y: 0 });

  editor.insertText("B");
  assert.equal(editor.document.getCell(3, 0), "B");
  assert.equal(editor.document.getTextCell(1, 0), null);
  assert.equal(editor.document.getTextCell(2, 0), null);
  assert.equal(editor.document.cellCount, 2);
  assert.deepEqual(editor.search("A B"), []);
  assert.deepEqual(editor.search("A  B"), []);
});

test("pasted repeated spaces preserve empty-cell distance", () => {
  const editor = new EditorModel();
  editor.insertText("A  B");

  assert.equal(editor.document.getCell(0, 0), "A");
  assert.equal(editor.document.getCell(1, 0), null);
  assert.equal(editor.document.getCell(2, 0), null);
  assert.equal(editor.document.getCell(3, 0), "B");
  assert.equal(editor.document.cellCount, 2);
  assert.deepEqual(editor.cursor, { x: 4, y: 0 });
});

test("spaces can extend an existing separator to multiple empty cells", () => {
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

  editor.insertText(" ");
  assert.deepEqual(editor.cursor, { x: 3, y: 0 });
  assert.equal(editor.document.getCell(2, 0), null);
  assert.equal(editor.document.getCell(3, 0), "C");
  assert.deepEqual(editor.search("A C"), []);
});

test("repeated spaces inserted inside text shift it by every cell", () => {
  const editor = new EditorModel();
  editor.insertText("AB");
  editor.setCursor({ x: 1, y: 0 });
  editor.insertText("  ");

  assert.equal(editor.document.getCell(0, 0), "A");
  assert.equal(editor.document.getCell(1, 0), null);
  assert.equal(editor.document.getCell(2, 0), null);
  assert.equal(editor.document.getCell(3, 0), "B");
  assert.deepEqual(editor.cursor, { x: 3, y: 0 });
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

test("overwrite mode replaces graphemes, spaces, and multiline paste in place", () => {
  const editor = new EditorModel();
  editor.insertText("ABCDE");
  editor.setCursor({ x: 0, y: 1 });
  editor.insertText("12345");
  editor.setCursor({ x: 1, y: 0 });

  editor.toggleOverwriteMode();
  assert.equal(editor.overwriteMode, true);
  editor.insertText("한 \nXY");

  assert.equal(editor.document.getCell(0, 0), "A");
  assert.equal(editor.document.getCell(1, 0), "한");
  assert.equal(editor.document.getCell(2, 0), null);
  assert.equal(editor.document.getCell(3, 0), "D");
  assert.equal(editor.document.getCell(4, 0), "E");
  assert.equal(editor.document.getCell(0, 1), "1");
  assert.equal(editor.document.getCell(1, 1), "X");
  assert.equal(editor.document.getCell(2, 1), "Y");
  assert.equal(editor.document.getCell(3, 1), "4");
  assert.equal(editor.document.getCell(4, 1), "5");
  assert.deepEqual(editor.cursor, { x: 3, y: 1 });

  editor.undo();
  assert.equal(editor.document.getCell(1, 0), "B");
  assert.equal(editor.document.getCell(2, 0), "C");
  assert.equal(editor.document.getCell(1, 1), "2");
  assert.equal(editor.overwriteMode, true);
});

test("overwrite mode persists through cursor and selected-text movement", () => {
  const editor = new EditorModel();
  editor.insertText("AB");
  editor.toggleOverwriteMode();
  editor.moveCursor(-1, 0);
  editor.setSelection({ x1: 0, y1: 0, x2: 2, y2: 1 });
  editor.moveCursorOrSelection(0, 1);

  assert.equal(editor.overwriteMode, true);
  assert.equal(editor.document.getCell(0, 0), null);
  assert.equal(editor.document.getCell(0, 1), "A");
  assert.equal(editor.document.getCell(1, 1), "B");

  editor.toggleOverwriteMode();
  assert.equal(editor.overwriteMode, false);
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

test("backspace at a line start returns the cursor to the previous line end", () => {
  const editor = new EditorModel();
  editor.insertText("ㄱㄴㄷ");
  editor.enter();
  assert.deepEqual(editor.cursor, { x: 0, y: 1 });

  editor.backspace();
  assert.deepEqual(editor.cursor, { x: 3, y: 0 });
  assert.equal(editor.document.getCell(0, 0), "ㄱ");
  assert.equal(editor.document.getCell(2, 0), "ㄷ");

  const twoLines = new EditorModel();
  twoLines.insertText("ㄱ ㄴㄷ");
  twoLines.setCursor({ x: 0, y: 1 });
  twoLines.insertText("ㄹ ㅁㅂ");
  twoLines.setCursor({ x: 0, y: 1 });

  twoLines.backspace();
  assert.deepEqual(twoLines.cursor, { x: 4, y: 0 });
  assert.equal(twoLines.document.getCell(4, 0), "ㄹ");
  assert.equal(twoLines.document.getCell(5, 0), null);
  assert.equal(twoLines.document.getTextCell(5, 0), " ");
  assert.equal(twoLines.document.getCell(6, 0), "ㅁ");
  assert.equal(twoLines.document.getCell(7, 0), "ㅂ");
  assert.equal(twoLines.document.getCell(0, 1), null);
  assert.equal(twoLines.document.getCell(2, 1), null);
  assert.equal(twoLines.document.getCell(3, 1), null);
});

test("backspace joins a current line to the previous line", () => {
  const editor = new EditorModel();
  editor.insertText("abc");
  editor.setCursor({ x: 0, y: 1 });
  editor.insertText("def");
  editor.setCursor({ x: 0, y: 1 });

  editor.backspace();

  for (const [x, value] of [..."abcdef"].entries()) {
    assert.equal(editor.document.getCell(x, 0), value);
    assert.equal(editor.document.getCell(x, 1), null);
  }
  assert.deepEqual(editor.cursor, { x: 3, y: 0 });

  editor.undo();
  for (const [x, value] of [..."abc"].entries()) {
    assert.equal(editor.document.getCell(x, 0), value);
  }
  for (const [x, value] of [..."def"].entries()) {
    assert.equal(editor.document.getCell(x, 1), value);
  }
  assert.deepEqual(editor.cursor, { x: 0, y: 1 });
});

test("backspace line join reverses Enter for its connected lower block", () => {
  const editor = new EditorModel();
  editor.insertText("abcdef");
  editor.setCursor({ x: 0, y: 1 });
  editor.insertText("hello");
  editor.setCursor({ x: 3, y: 0 });
  editor.enter();

  editor.backspace();

  for (const [x, value] of [..."abcdef"].entries()) {
    assert.equal(editor.document.getCell(x, 0), value);
  }
  for (const [x, value] of [..."hello"].entries()) {
    assert.equal(editor.document.getCell(x, 1), value);
    assert.equal(editor.document.getCell(x, 2), null);
  }
  assert.deepEqual(editor.cursor, { x: 3, y: 0 });
});

test("backspace line join is rejected atomically on collision", () => {
  const editor = new EditorModel();
  editor.document.setCell(0, 0, "A");
  editor.document.setCell(4, 0, "X");
  editor.setCursor({ x: 0, y: 1 });
  editor.insertText("BCDE");
  editor.setCursor({ x: 0, y: 1 });

  assert.throws(() => editor.backspace(), /충돌/);
  assert.equal(editor.document.getCell(0, 0), "A");
  assert.equal(editor.document.getCell(4, 0), "X");
  for (const [x, value] of [..."BCDE"].entries()) {
    assert.equal(editor.document.getCell(x, 1), value);
  }
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

test("backspace collapses selected cells and pulls attached text left", () => {
  const leadingBlank = new EditorModel();
  leadingBlank.setCursor({ x: 4, y: 0 });
  leadingBlank.insertText("abcdefg");
  leadingBlank.setSelection({ x1: 0, y1: 0, x2: 4, y2: 1 });

  leadingBlank.backspace();
  assert.deepEqual(leadingBlank.cursor, { x: 0, y: 0 });
  assert.equal(leadingBlank.selection, null);
  assert.equal(leadingBlank.document.getCell(0, 0), "a");
  assert.equal(leadingBlank.document.getCell(6, 0), "g");
  assert.equal(leadingBlank.document.getCell(7, 0), null);

  leadingBlank.undo();
  assert.equal(leadingBlank.document.getCell(0, 0), null);
  assert.equal(leadingBlank.document.getCell(4, 0), "a");
  assert.equal(leadingBlank.document.getCell(10, 0), "g");
  assert.deepEqual(leadingBlank.selection, {
    x1: 0,
    y1: 0,
    x2: 4,
    y2: 1,
  });

  const containingText = new EditorModel();
  containingText.insertText("ABCDEFG");
  containingText.setSelection({ x1: 1, y1: 0, x2: 3, y2: 1 });
  containingText.backspace();

  assert.equal(containingText.document.getCell(0, 0), "A");
  assert.equal(containingText.document.getCell(1, 0), "D");
  assert.equal(containingText.document.getCell(4, 0), "G");
  assert.equal(containingText.document.getCell(5, 0), null);
  assert.deepEqual(containingText.cursor, { x: 1, y: 0 });
});

test("selection backspace does not pull detached text", () => {
  const editor = new EditorModel();
  editor.setCursor({ x: 5, y: 0 });
  editor.insertText("AB");
  editor.setSelection({ x1: 0, y1: 0, x2: 3, y2: 1 });

  editor.backspace();
  assert.equal(editor.document.getCell(5, 0), "A");
  assert.equal(editor.document.getCell(6, 0), "B");
  assert.deepEqual(editor.cursor, { x: 0, y: 0 });
});

test("arrow commands move a selection or the cursor by one cell", () => {
  const editor = new EditorModel();
  editor.insertText("AB");
  editor.setSelection({ x1: 0, y1: 0, x2: 2, y2: 1 });
  editor.moveCursorOrSelection(0, 1);
  assert.equal(editor.document.getCell(0, 0), null);
  assert.equal(editor.document.getCell(0, 1), "A");
  assert.equal(editor.document.getCell(1, 1), "B");
  assert.deepEqual(editor.cursor, { x: 0, y: 1 });
  assert.deepEqual(editor.selection, { x1: 0, y1: 1, x2: 2, y2: 2 });

  editor.setSelection(null);
  editor.moveCursorOrSelection(-1, 0);
  assert.deepEqual(editor.cursor, { x: -1, y: 1 });
  assert.equal(editor.selection, null);
});

test("drag selection uses the same horizontal boundaries as the cursor", () => {
  assert.deepEqual(
    selectionFromCursorDrag({ x: 0, y: 2 }, { x: 1, y: 2 }),
    { x1: 0, y1: 2, x2: 1, y2: 3 },
  );
  assert.deepEqual(
    selectionFromCursorDrag({ x: 3, y: 2 }, { x: 0, y: 2 }),
    { x1: 0, y1: 2, x2: 3, y2: 3 },
  );
  assert.deepEqual(
    selectionFromCursorDrag({ x: 4, y: 1 }, { x: 4, y: 3 }),
    { x1: 4, y1: 1, x2: 5, y2: 4 },
  );
  assert.equal(
    selectionFromCursorDrag({ x: -2, y: 5 }, { x: -2, y: 5 }),
    null,
  );
});

test("selection auto-pan velocity follows viewport edges and outside drag", () => {
  assert.equal(MIN_ZOOM, 0.05);
  assert.equal(selectionAutoPanVelocity(400, 800), 0);
  assert.ok(selectionAutoPanVelocity(20, 800) < 0);
  assert.ok(selectionAutoPanVelocity(780, 800) > 0);
  assert.equal(selectionAutoPanVelocity(-200, 800), -900);
  assert.equal(selectionAutoPanVelocity(1000, 800), 900);
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

test("insert-mode movement pushes only the sentence overlapping its target", () => {
  const editor = new EditorModel();
  editor.document.setCell(0, 0, "S");
  editor.document.setCell(2, 0, "A");
  editor.document.setCell(3, 0, "B");
  editor.document.setCell(4, 0, "C");
  editor.setSelection({ x1: 0, y1: 0, x2: 1, y2: 1 });

  editor.moveSelection(2, 0);

  assert.equal(editor.document.getCell(2, 0), "S");
  assert.equal(editor.document.getCell(3, 0), "A");
  assert.equal(editor.document.getCell(4, 0), "B");
  assert.equal(editor.document.getCell(5, 0), "C");
  assert.equal(editor.document.getCell(0, 0), null);
  assert.equal(editor.document.getCell(1, 0), null);

  editor.undo();
  assert.equal(editor.document.getCell(0, 0), "S");
  assert.equal(editor.document.getCell(2, 0), "A");
  assert.equal(editor.document.getCell(4, 0), "C");
});

test("selection movement leaves non-target path blocks in place", () => {
  const editor = new EditorModel();
  editor.document.setCell(0, 0, "S");
  editor.document.setCell(2, 0, "A");
  editor.document.setCell(6, 0, "T");
  editor.setSelection({ x1: 0, y1: 0, x2: 1, y2: 1 });

  editor.moveSelection(6, 0);

  assert.equal(editor.document.getCell(6, 0), "S");
  assert.equal(editor.document.getCell(2, 0), "A");
  assert.equal(editor.document.getCell(7, 0), "T");
});

test("selection pushing follows the nearest cardinal relative direction", () => {
  const left = new EditorModel();
  left.document.setCell(5, 0, "S");
  left.insertText("ABC");
  left.setSelection({ x1: 5, y1: 0, x2: 6, y2: 1 });
  left.moveSelection(-3, 0);
  assert.equal(left.document.getCell(2, 0), "S");
  assert.equal(left.document.getCell(-1, 0), "A");
  assert.equal(left.document.getCell(0, 0), "B");
  assert.equal(left.document.getCell(1, 0), "C");

  const vertical = new EditorModel();
  vertical.document.setCell(1, 0, "S");
  for (const [y, value] of [..."ABC"].entries()) {
    vertical.document.setCell(1, y + 3, value);
  }
  vertical.setSelection({ x1: 1, y1: 0, x2: 2, y2: 1 });
  vertical.moveSelection(0, 3);
  assert.equal(vertical.document.getCell(1, 3), "S");
  for (const [y, value] of [..."ABC"].entries()) {
    assert.equal(vertical.document.getCell(1, y + 4), value);
  }

  const horizontalTie = new EditorModel();
  horizontalTie.document.setCell(0, 0, "S");
  horizontalTie.document.setCell(2, 2, "A");
  horizontalTie.document.setCell(3, 2, "B");
  horizontalTie.document.setCell(3, 3, "C");
  horizontalTie.setSelection({ x1: 0, y1: 0, x2: 1, y2: 1 });
  horizontalTie.moveSelection(2, 2);
  assert.equal(horizontalTie.document.getCell(2, 2), "S");
  assert.equal(horizontalTie.document.getCell(3, 2), "A");
  assert.equal(horizontalTie.document.getCell(4, 2), "B");
  assert.equal(horizontalTie.document.getCell(4, 3), "C");

  const verticalNearest = new EditorModel();
  verticalNearest.document.setCell(0, 0, "S");
  for (const [offset, value] of [..."ABCDE"].entries()) {
    verticalNearest.document.setCell(offset + 1, 2, value);
  }
  verticalNearest.document.setCell(5, 3, "F");
  verticalNearest.setSelection({ x1: 0, y1: 0, x2: 1, y2: 1 });
  verticalNearest.moveSelection(2, 2);
  assert.equal(verticalNearest.document.getCell(2, 2), "S");
  assert.equal(verticalNearest.document.getCell(1, 3), "A");
  assert.equal(verticalNearest.document.getCell(5, 3), "E");
  assert.equal(verticalNearest.document.getCell(5, 4), "F");
});

test("centered overlap uses the shortest exit direction", () => {
  const editor = new EditorModel();
  editor.document.setCell(0, 2, "S");
  editor.insertText("ABCDE");
  editor.setSelection({ x1: 0, y1: 2, x2: 5, y2: 3 });

  editor.moveSelection(0, -2);

  assert.equal(editor.copySelection(), "S    ");
  assert.equal(editor.document.getCell(0, 1), "A");
  assert.equal(editor.document.getCell(4, 1), "E");
});

test("pushed target sentences move colliding blocks in a chain", () => {
  const editor = new EditorModel();
  editor.document.setCell(0, 0, "X");
  editor.document.setCell(1, 0, "Y");
  for (const [offset, value] of [..."ABCD"].entries()) {
    editor.document.setCell(offset + 5, 0, value);
  }
  editor.document.setCell(11, 0, "T");
  editor.setSelection({ x1: 0, y1: 0, x2: 2, y2: 1 });

  editor.moveSelection(5, 0);

  assert.equal(editor.document.getCell(5, 0), "X");
  assert.equal(editor.document.getCell(6, 0), "Y");
  for (const [offset, value] of [..."ABCD"].entries()) {
    assert.equal(editor.document.getCell(offset + 7, 0), value);
  }
  assert.equal(editor.document.getCell(12, 0), "T");
});

test("an empty target uses simple movement even when the path has text", () => {
  const editor = new EditorModel();
  editor.document.setCell(0, 0, "S");
  editor.document.setCell(2, 0, "A");
  editor.setSelection({ x1: 0, y1: 0, x2: 1, y2: 1 });

  editor.moveSelection(4, 0);

  assert.equal(editor.document.getCell(0, 0), null);
  assert.equal(editor.document.getCell(2, 0), "A");
  assert.equal(editor.document.getCell(4, 0), "S");
});

test("overwrite-mode selection movement replaces the target in place", () => {
  const editor = new EditorModel();
  editor.insertText("ABCDE");
  editor.setCursor({ x: 1, y: 1 });
  editor.insertText("XY");
  editor.setSelection({ x1: 1, y1: 1, x2: 3, y2: 2 });
  editor.toggleOverwriteMode();

  editor.moveSelection(0, -1);

  assert.equal(editor.document.getCell(0, 0), "A");
  assert.equal(editor.document.getCell(1, 0), "X");
  assert.equal(editor.document.getCell(2, 0), "Y");
  assert.equal(editor.document.getCell(3, 0), "D");
  assert.equal(editor.document.getCell(4, 0), "E");
});

test("horizontal selection resize wraps only when shrinking", () => {
  const editor = new EditorModel();
  editor.insertText("ABCDEFGH");
  editor.setSelection({ x1: 0, y1: 0, x2: 8, y2: 1 });

  editor.resizeSelectionHorizontal("right", 3);
  assert.equal(editor.copySelection(), "ABC\nDEF\nGH ");
  assert.deepEqual(editor.selection, { x1: 0, y1: 0, x2: 3, y2: 3 });
  assert.deepEqual(editor.cursor, { x: 0, y: 0 });

  editor.resizeSelectionHorizontal("right", 8);
  assert.equal(editor.copySelection(), "ABC     \nDEF     \nGH      ");
  assert.deepEqual(editor.selection, { x1: 0, y1: 0, x2: 8, y2: 3 });

  editor.undo();
  assert.equal(editor.copySelection(), "ABCDEFGH");
  assert.deepEqual(editor.selection, { x1: 0, y1: 0, x2: 8, y2: 1 });
  editor.redo();
  assert.equal(editor.copySelection(), "ABC\nDEF\nGH ");
  assert.deepEqual(editor.selection, { x1: 0, y1: 0, x2: 3, y2: 3 });
});

test("horizontal selection shrink preserves existing line breaks", () => {
  const editor = new EditorModel();
  for (const [x, y, value] of [
    [0, 0, "A"],
    [1, 0, "B"],
    [2, 0, "C"],
    [3, 0, "D"],
    [4, 0, "E"],
    [0, 1, "F"],
    [1, 1, "G"],
    [0, 3, "H"],
    [1, 3, "I"],
    [2, 3, "J"],
    [3, 3, "K"],
  ] as const) {
    editor.document.setCell(x, y, value);
  }
  editor.setSelection({ x1: 0, y1: 0, x2: 5, y2: 4 });

  editor.resizeSelectionHorizontal("right", 3);

  assert.equal(editor.copySelection(), "ABC\nDE \nFG \n   \nHIJ\nK  ");
  assert.deepEqual(editor.selection, { x1: 0, y1: 0, x2: 3, y2: 6 });
});

test("selection shrink wraps at an in-bounds text line start", () => {
  const editor = new EditorModel();
  editor.setCursor({ x: 4, y: 0 });
  editor.insertText("ABCDEF");
  editor.setSelection({ x1: 0, y1: 0, x2: 10, y2: 1 });

  editor.resizeSelectionHorizontal("right", 7);

  assert.deepEqual(editor.selection, { x1: 0, y1: 0, x2: 7, y2: 2 });
  assert.equal(editor.document.getCell(4, 0), "A");
  assert.equal(editor.document.getCell(6, 0), "C");
  assert.equal(editor.document.getCell(4, 1), "D");
  assert.equal(editor.document.getCell(6, 1), "F");
  assert.equal(editor.document.getCell(0, 1), null);
});

test("selection shrink falls back to its left edge when line start is outside", () => {
  const editor = new EditorModel();
  editor.setCursor({ x: 4, y: 0 });
  editor.insertText("ABCDEF");
  editor.setSelection({ x1: 0, y1: 0, x2: 10, y2: 1 });

  editor.resizeSelectionHorizontal("right", 3);

  assert.deepEqual(editor.selection, { x1: 0, y1: 0, x2: 3, y2: 2 });
  assert.equal(editor.document.getCell(0, 0), "A");
  assert.equal(editor.document.getCell(2, 0), "C");
  assert.equal(editor.document.getCell(0, 1), "D");
  assert.equal(editor.document.getCell(2, 1), "F");
});

test("left selection edge shrink reflows content at the bounded line start", () => {
  const editor = new EditorModel();
  editor.setCursor({ x: 4, y: 0 });
  editor.insertText("ABCDEF");
  editor.setSelection({ x1: 0, y1: 0, x2: 10, y2: 1 });

  editor.resizeSelectionHorizontal("left", 5);

  assert.deepEqual(editor.selection, { x1: 5, y1: 0, x2: 10, y2: 2 });
  assert.equal(editor.document.getCell(4, 0), null);
  assert.equal(editor.document.getCell(5, 0), "A");
  assert.equal(editor.document.getCell(9, 0), "E");
  assert.equal(editor.document.getCell(5, 1), "F");
  assert.equal(editor.document.getCell(6, 1), null);
});

test("top and bottom selection edges change bounds without moving text", () => {
  const editor = new EditorModel();
  editor.document.setCell(2, 1, "A");
  editor.document.setCell(2, 2, "B");
  editor.document.setCell(2, 3, "C");
  editor.setSelection({ x1: 2, y1: 1, x2: 3, y2: 4 });

  editor.resizeSelectionVertical("top", 2);
  assert.deepEqual(editor.selection, { x1: 2, y1: 2, x2: 3, y2: 4 });
  assert.equal(editor.document.getCell(2, 1), "A");
  assert.equal(editor.document.getCell(2, 2), "B");

  editor.resizeSelectionVertical("bottom", 3);
  assert.deepEqual(editor.selection, { x1: 2, y1: 2, x2: 3, y2: 3 });
  assert.equal(editor.document.getCell(2, 3), "C");

  editor.resizeSelectionVertical("top", 0);
  editor.resizeSelectionVertical("bottom", 5);
  assert.deepEqual(editor.selection, { x1: 2, y1: 0, x2: 3, y2: 5 });
  assert.equal(editor.document.getCell(2, 1), "A");
  assert.equal(editor.document.getCell(2, 2), "B");
  assert.equal(editor.document.getCell(2, 3), "C");
});

test("horizontal selection resize rejects a zero-width target", () => {
  const editor = new EditorModel();
  editor.insertText("ABC");
  editor.setSelection({ x1: 0, y1: 0, x2: 3, y2: 1 });

  assert.throws(
    () => editor.resizeSelectionHorizontal("right", 0),
    /한 칸 이상/,
  );
  assert.equal(editor.copySelection(), "ABC");
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

test("editor change events distinguish persistent and transient state", () => {
  const editor = new EditorModel();
  const events: string[] = [];
  editor.subscribe((change) => events.push(change));

  editor.moveCursor(1, 0);
  editor.setSelection({ x1: 0, y1: 0, x2: 1, y2: 1 });
  editor.setSelection(null);
  editor.search("A");
  assert.deepEqual(events, ["transient", "transient", "transient", "transient"]);

  events.length = 0;
  editor.insertText("A");
  editor.addBookmark("시작");
  editor.undo();
  assert.deepEqual(events, ["document", "bookmarks", "document"]);
});
