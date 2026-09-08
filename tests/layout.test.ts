import assert from "node:assert/strict";
import test from "node:test";
import { SparseDocument } from "../lib/document";
import { EditorModel } from "../lib/editor";
import { graphemeWidth, textWidth } from "../lib/graphemes";
import { exportJson, exportTxt, importJson } from "../lib/io";
import { cameraToReveal, cellMetrics, logicalToScreen } from "../lib/renderer";

function assertWholeCharacters(document: SparseDocument) {
  let count = document.storedCellCount;
  for (const [position, value] of document.entries()) {
    if (document.isInterCharacterSpace(position.x + graphemeWidth(value), position.y)) count += 1;
    if (graphemeWidth(value) === 2) {
      assert.equal(document.getCell(position.x + 1, position.y), null, `overlap at ${position.x},${position.y}`);
      assert.equal(document.getRasterCell(position.x + 1, position.y), "");
    }
  }
  assert.equal(document.cellCount, count);
}

test("display widths cover ASCII, CJK, combining marks, halfwidth and emoji", () => {
  for (const value of ["A", " ", "é", "e\u0301", "ｶ", "Ω"]) assert.equal(graphemeWidth(value), 1, value);
  for (const value of ["한", "한", "漢", "あ", "Ａ", "　", "𠀀", "👨‍👩‍👧‍👦", "🇰🇷", "1️⃣"]) {
    assert.equal(graphemeWidth(value), 2, value);
  }
  assert.equal(textWidth("A한 漢e\u0301"), 7);
});

test("mixed width text round trips through copy, search, TXT and JSON", () => {
  const editor = new EditorModel();
  editor.setCursor({ x: -65, y: -1 });
  editor.insertText("한 A漢👨‍👩‍👧‍👦");
  assert.deepEqual(editor.cursor, { x: -57, y: -1 });
  assert.equal(editor.document.cellCount, 5);
  assert.equal(editor.document.storedCellCount, 4);
  assert.deepEqual(editor.search("한 A漢"), [{ x: -65, y: -1 }]);
  assert.deepEqual(editor.search("漢👨‍👩‍👧‍👦"), [{ x: -61, y: -1 }]);
  editor.setSelection({ x1: -65, y1: -1, x2: -57, y2: 0 });
  assert.equal(editor.copySelection(), "한 A漢👨‍👩‍👧‍👦");
  assert.equal(exportTxt(editor.document), editor.copySelection());
  const json = exportJson(editor.document, [], { x: 0, y: 0, zoom: 1 });
  assert.equal(exportJson(importJson(json).document, [], { x: 0, y: 0, zoom: 1 }), json);
  assertWholeCharacters(editor.document);
});

test("cursor, backspace and delete treat wide graphemes as indivisible", () => {
  const editor = new EditorModel();
  editor.insertText("A한漢B");
  editor.setCursor({ x: 2, y: 0 });
  assert.equal(editor.cursor.x, 1);
  editor.moveCursor(1, 0);
  assert.equal(editor.cursor.x, 3);
  editor.backspace();
  assert.equal(exportTxt(editor.document), "A漢B");
  assert.equal(editor.cursor.x, 1);
  editor.deleteForward();
  assert.equal(exportTxt(editor.document), "AB");
  editor.undo(); editor.undo();
  assert.equal(exportTxt(editor.document), "A한漢B");
  editor.redo(); editor.redo();
  assert.equal(exportTxt(editor.document), "AB");
});

test("wide insertions and overwrites include collisions in the second column", () => {
  for (const overwrite of [false, true]) {
    const editor = new EditorModel();
    editor.document.setCell(1, 0, "漢");
    editor.overwriteMode = overwrite;
    editor.insertText("한");
    assert.equal(exportTxt(editor.document), overwrite ? "한" : "한 漢");
    assertWholeCharacters(editor.document);
    editor.undo();
    assert.equal(editor.document.getCell(1, 0), "漢");
  }
});

test("Enter and line joining preserve wide text and connected lower rows", () => {
  const editor = new EditorModel();
  editor.insertText("한AB漢\n가나");
  const before = exportTxt(editor.document);
  editor.setCursor({ x: 2, y: 0 });
  editor.enter();
  assert.equal(editor.document.getCell(0, 1), "A");
  assert.equal(editor.document.getCell(2, 1), "漢");
  assert.equal(editor.document.getCell(0, 2), "가");
  assertWholeCharacters(editor.document);
  editor.backspace();
  assert.equal(exportTxt(editor.document), before);
});

test("partial wide selections keep their bounds and include half-covered boundary glyphs", () => {
  const editor = new EditorModel();
  editor.insertText("한A漢");
  editor.setSelection({ x1: 1, y1: 0, x2: 4, y2: 1 });
  assert.deepEqual(editor.selection, { x1: 1, y1: 0, x2: 4, y2: 1 });
  assert.equal(editor.copySelection(), "한A漢");
  editor.moveSelection(2, 1);
  assert.equal(editor.document.getCell(0, 0), null);
  assert.equal(editor.document.getCell(3, 0), null);
  assert.equal(editor.copySelection(), "한A漢");
  assertWholeCharacters(editor.document);
  editor.deleteSelection();
  assert.equal(editor.document.storedCellCount, 0);
  editor.undo(); editor.undo();
  assert.equal(exportTxt(editor.document), "한A漢");
});

test("moving a selection into the trailing column pushes the complete wide block", () => {
  const editor = new EditorModel();
  editor.insertText("X");
  editor.document.setCell(4, 0, "한");
  editor.setSelection({ x1: 0, y1: 0, x2: 1, y2: 1 });
  editor.moveSelection(5, 0);
  assert.equal(editor.document.getCell(5, 0), "X");
  assert.equal(editor.document.getCell(6, 0), "한");
  assertWholeCharacters(editor.document);
});

test("mixed width reflow wraps before wide characters and restores logical lines", () => {
  const editor = new EditorModel();
  editor.insertText("A한B漢\n가나");
  editor.setSelection({ x1: 0, y1: 0, x2: 6, y2: 2 });
  editor.resizeSelectionHorizontal("right", 2);
  assert.equal(editor.copySelection(), "A \n한\nB \n漢\n가\n나");
  assertWholeCharacters(editor.document);
  editor.resizeSelectionHorizontal("right", 6);
  assert.equal(editor.copySelection(), "A한B漢\n가나  ");
  editor.undo();
  assert.equal(editor.copySelection(), "A \n한\nB \n漢\n가\n나");
  assert.throws(() => editor.resizeSelectionHorizontal("right", 1), /두 칸/);
});

test("growth pushes blocks only when actual reflowed characters overlap", () => {
  for (const edge of ["left", "right"] as const) {
    const editor = new EditorModel();
    editor.insertText("ABCDEFGH");
    editor.setSelection({ x1: 0, y1: 0, x2: 8, y2: 1 });
    editor.resizeSelectionHorizontal(edge, edge === "right" ? 3 : 5);
    editor.document.setCell(edge === "right" ? 5 : 3, 0, "X");
    editor.resizeSelectionHorizontal(edge, edge === "right" ? 10 : -2);
    assert.equal(editor.document.getCell(edge === "right" ? 10 : -3, 0), "X");
    assertWholeCharacters(editor.document);
  }
});

test("adopted text survives repeated reflow, movement, undo and redo", () => {
  const editor = new EditorModel();
  editor.insertText("ABCDEFGH");
  editor.document.setCell(8, 0, "漢");
  editor.setSelection({ x1: 0, y1: 0, x2: 8, y2: 1 });
  editor.resizeSelectionHorizontal("right", 3);
  editor.resizeSelectionHorizontal("right", 10);
  assert.equal(editor.selection?.x2, 10);
  assert.equal(editor.copySelection(), "ABCDEFGH漢");
  editor.resizeSelectionHorizontal("right", 4);
  assert.equal(editor.copySelection(), "ABCD\nEFGH\n漢  ");
  editor.moveSelection(-10, 2);
  editor.resizeSelectionHorizontal("right", 0);
  assert.equal(editor.copySelection(), "ABCDEFGH漢");
  editor.undo(); editor.redo();
  assert.equal(editor.copySelection(), "ABCDEFGH漢");
  assertWholeCharacters(editor.document);
});

test("adopting text in a wrapped row retains original line boundaries", () => {
  const editor = new EditorModel();
  editor.insertText("ABCDEFGH\nIJKL");
  editor.setSelection({ x1: 0, y1: 0, x2: 8, y2: 2 });
  editor.resizeSelectionHorizontal("right", 3);
  editor.document.setCell(4, 1, "X");
  editor.resizeSelectionHorizontal("right", 5);
  editor.resizeSelectionHorizontal("right", 10);
  assert.equal(editor.copySelection(), "ABCDEFGH X\nIJKL      ");
});

test("changing vertical bounds resets stale reflow content", () => {
  const editor = new EditorModel();
  editor.insertText("ABCDEF");
  editor.setSelection({ x1: 0, y1: 0, x2: 6, y2: 1 });
  editor.resizeSelectionHorizontal("right", 3);
  editor.resizeSelectionVertical("bottom", 1);
  editor.resizeSelectionHorizontal("right", 6);
  assert.equal(editor.copySelection(), "ABC   ");
  assert.equal(editor.document.getCell(0, 1), "D");
});

test("legacy overlapping anchors load without losing characters across chunks", () => {
  const document = SparseDocument.fromChunks([
    { x: 0, y: 0, cells: [[63, "한"]] },
    { x: 1, y: 0, cells: [[0, "漢"], [1, "A"], [4, "Z"]] },
  ]);
  assert.equal(exportTxt(document), "한漢A  Z");
  assertWholeCharacters(document);
});

test("invalid or overflowing mixed-width edits remain atomic", () => {
  const editor = new EditorModel();
  editor.insertText("safe");
  editor.setCursor({ x: Number.MAX_SAFE_INTEGER - 2, y: 0 });
  const before = editor.document.sortedChunks();
  assert.throws(() => editor.insertText("A한"), /좌표/);
  assert.deepEqual(editor.document.sortedChunks(), before);
  assert.throws(() => editor.insertText("A" + "x" + "\u0301".repeat(256)), /문자소/);
  assert.deepEqual(editor.document.sortedChunks(), before);
});

test("camera reveal follows cursor and selection edges at every zoom", () => {
  const viewport = { width: 600, height: 400 };
  for (const zoom of [0.05, 1, 4]) {
    const camera = { x: 0, y: 0, zoom };
    const target = { x1: 1000, y1: -1000, x2: 1002, y2: -999 };
    const next = cameraToReveal(camera, viewport, target);
    const top = logicalToScreen({ x: target.x1, y: target.y1 }, next, viewport);
    const end = logicalToScreen({ x: target.x2, y: target.y2 }, next, viewport);
    assert.ok(top.x >= 23.9 && top.y >= 23.9);
    assert.ok(end.x <= 576.1 && end.y <= 376.1);
    assert.deepEqual(cameraToReveal(next, viewport, target), next);
    const huge = { x1: -10000, y1: 0, x2: 10000, y2: 1 };
    const shifted = cameraToReveal(camera, viewport, { ...huge, x1: huge.x1 + 1, x2: huge.x2 + 1 }, huge);
    assert.equal(shifted.x, huge.x2 + 1 - (viewport.width / 2 - 24) / cellMetrics(camera).width);
  }
});

test("mixed editing sequences keep all glyph footprints disjoint and undoable", () => {
  const editor = new EditorModel();
  let seed = 731;
  const random = (limit: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % limit; };
  for (let step = 0; step < 250; step += 1) {
    editor.setCursor({ x: random(25) - 12, y: random(5) - 2 });
    const before = editor.document.sortedChunks();
    try {
      switch (random(7)) {
        case 0: case 1: editor.insertText(["한A", " B漢", "가나", "X", "👨‍👩‍👧‍👦"][random(5)]); break;
        case 2: editor.backspace(); break;
        case 3: editor.deleteForward(); break;
        case 4: editor.enter(); break;
        default: {
          editor.setSelection({ x1: editor.cursor.x, y1: editor.cursor.y, x2: editor.cursor.x + 4, y2: editor.cursor.y + 2 });
          if (random(2)) editor.moveSelection(random(5) - 2, random(3) - 1);
          else editor.resizeSelectionHorizontal("right", editor.selection!.x1 + 3);
        }
      }
    } catch {
      assert.deepEqual(editor.document.sortedChunks(), before, `atomic failure at step ${step}`);
    }
    assertWholeCharacters(editor.document);
    const after = editor.document.sortedChunks();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      editor.undo(); assert.deepEqual(editor.document.sortedChunks(), before);
      editor.redo(); assert.deepEqual(editor.document.sortedChunks(), after);
    }
  }
});

test("wide glyph footprints cannot overflow the safe coordinate range", () => {
  const document = new SparseDocument();
  assert.throws(() => document.setCell(Number.MAX_SAFE_INTEGER, 0, "한"), /좌표/);
  assert.equal(document.cellCount, 0);
  document.setCell(Number.MAX_SAFE_INTEGER - 1, 0, "한");
  assert.equal(document.getRasterCell(Number.MAX_SAFE_INTEGER, 0), "");
  assert.throws(() => new EditorModel().setSelection({ x1: 0, y1: 0, x2: Infinity, y2: 1 }), /좌표/);
});

test("deleting or backspacing clipped selections removes half-covered boundary glyphs", () => {
  for (const command of ["deleteSelection", "deleteForward", "backspace"] as const) {
    const editor = new EditorModel();
    editor.insertText("한A漢B");
    editor.setSelection({ x1: 1, y1: 0, x2: 4, y2: 1 });
    editor[command]();
    assert.equal(editor.document.getCell(0, 0), null);
    assert.equal(editor.document.getCell(2, 0), null);
    assert.equal(editor.document.getCell(3, 0), null);
    assert.equal(editor.document.getCell(5, 0), "B");
    assertWholeCharacters(editor.document);
    editor.undo();
    assert.equal(exportTxt(editor.document), "한A漢B");
  }
});

test("a selection covering either half of a wide glyph copies and deletes the whole character", () => {
  for (const x of [-1, 0]) {
    const editor = new EditorModel();
    editor.document.setCell(-1, 0, "한");
    editor.setSelection({ x1: x, y1: 0, x2: x + 1, y2: 1 });
    assert.equal(editor.copySelection(), "한");
    editor.deleteSelection();
    assert.equal(editor.document.getCell(-1, 0), null);
    assert.notEqual(editor.document.getRasterCell(editor.cursor.x, editor.cursor.y), "");
  }
});

test("selection growth and vertical resize never expand horizontal bounds", () => {
  const editor = new EditorModel();
  editor.insertText("ABCDEFGH");
  editor.document.setCell(8, 0, "漢");
  editor.setSelection({ x1: 0, y1: 0, x2: 8, y2: 1 });
  editor.resizeSelectionHorizontal("right", 3);
  editor.resizeSelectionHorizontal("right", 9);
  assert.equal(editor.selection?.x2, 9);
  assert.equal(editor.copySelection(), "ABCDEFGH漢");
  editor.resizeSelectionHorizontal("right", 4);
  assert.equal(editor.copySelection(), "ABCD\nEFGH\n漢  ");
  assert.equal(editor.document.getCell(8, 0), null);
  editor.document.setCell(3, 3, "한");
  editor.resizeSelectionVertical("bottom", 4);
  assert.equal(editor.selection?.x2, 4);
  assert.equal(editor.copySelection().split("\n")[3], "   한");
});

test("replacing a clipped selection replaces the half-covered wide character", () => {
  for (const overwrite of [false, true]) {
    const editor = new EditorModel();
    editor.insertText("한AB");
    editor.overwriteMode = overwrite;
    editor.setSelection({ x1: 1, y1: 0, x2: 3, y2: 1 });
    editor.insertText("X");
    assert.equal(editor.document.getCell(0, 0), null);
    assert.equal(editor.document.getCell(1, 0), "X");
    assertWholeCharacters(editor.document);
    editor.undo();
    assert.equal(exportTxt(editor.document), "한AB");
  }
});
