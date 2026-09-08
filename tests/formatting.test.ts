import assert from "node:assert/strict";
import test from "node:test";
import { EditorModel } from "../lib/editor";
import { SparseDocument } from "../lib/document";
import { DEFAULT_TEXT_STYLE, BASE_FONT_SIZE, nextFontSize, parseTextStyle, type TextStyle } from "../lib/formatting";
import { getTextLayout } from "../lib/layout";
import { exportJson, exportTxt, importJson } from "../lib/io";
import { copyRichText, readRichText } from "../lib/clipboard";
import { IndexedDocumentStorage } from "../lib/storage";
import { cameraToReveal, logicalToScreen, screenToCell } from "../lib/renderer";
import { intersects } from "../lib/coverage";

const large: TextStyle = { ...DEFAULT_TEXT_STYLE, fontSize: 2, bold: true };
const small: TextStyle = { ...DEFAULT_TEXT_STYLE, italic: true, underline: true };
const camera = { x: 0, y: 0, zoom: 1 };
function select(editor: EditorModel, x1: number, x2: number, y1 = 0, y2 = 1) {
  editor.setSelection({ x1, x2, y1, y2 });
}
function stylesByText(editor: EditorModel): Array<[string, TextStyle]> {
  return [...editor.document.entries()].sort((a, b) => a[0].y - b[0].y || a[0].x - b[0].x)
    .map(([p, text]) => [text, editor.document.getStyle(p.x, p.y)]);
}
function disjoint(editor: EditorModel) {
  const cells = [...editor.document.entries()];
  for (const [index, [p, text]] of cells.entries()) {
    const rect = editor.document.footprint(p.x, p.y);
    for (const [q, other] of cells.slice(index + 1)) {
      const b = editor.document.footprint(q.x, q.y);
      assert.equal(intersects(rect, { x1: b.x, x2: b.x + b.width, y1: b.y, y2: b.y + b.height }), false, `${text} overlaps ${other}`);
    }
  }
}

test("font sizes are natural-number multipliers with base 1 and no preset upper bound", () => {
  assert.equal(BASE_FONT_SIZE, 1);
  assert.equal(nextFontSize(1, -1), 1);
  assert.equal(nextFontSize(1, 1), 2);
  assert.equal(nextFontSize(200, 1), 201);
  assert.equal(nextFontSize(200, -1), 199);
  const editor = new EditorModel(); editor.insertText("AB"); select(editor, 0, 2);
  const before = exportJson(editor.document, [], camera);
  for (const fontSize of [0, -1, 0.5, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => editor.applyStyle({ fontSize }));
    assert.equal(exportJson(editor.document, [], camera), before);
  }
  for (const fontSize of [1, 2, 97, 4096, 1_000_000]) assert.equal(parseTextStyle({ ...large, fontSize }).fontSize, fontSize);
  editor.applyStyle({ fontSize: 1_000_000 });
  assert.equal(editor.document.storedCellCount, 2);
  assert.deepEqual(editor.selection, { x1: 0, x2: 2_000_000, y1: 0, y2: 1_000_000 });
  assert.equal(editor.copySelection(), "AB");
  editor.resizeSelectionHorizontal("right", 1_000_000);
  assert.equal(editor.copySelection(), "A\nB");
  editor.resizeSelectionHorizontal("right", 2_000_000);
  assert.equal(editor.copySelection(), "AB");
  editor.moveSelection(-3, 7);
  assert.equal(editor.document.getCell(-3, 7), "A");
  assert.equal(editor.document.getCell(999_997, 7), "B");
  assert.deepEqual(editor.document.snapPosition({ x: 12, y: 999_999 }), { x: -3, y: 7 });
  editor.setSelection(null); editor.setCursor({ x: 1_999_997, y: 7 }); editor.backspace();
  assert.equal(editor.document.storedCellCount, 1);
});

test("typing toggles stay pending and cursor inheritance reads the entire left glyph", () => {
  const editor = new EditorModel(); editor.applyStyle(large);
  assert.equal(editor.canUndo, false); assert.equal(editor.document.isDirty, false);
  editor.insertText("A한👩‍💻");
  assert.deepEqual(editor.cursor, { x: 10, y: 0 });
  editor.toggleStyle("bold"); editor.insertText("Z");
  assert.equal(editor.document.getStyle(10, 0).bold, false);
  editor.setCursor({ x: 6, y: 0 }); assert.deepEqual(editor.formatting, large);
  editor.setCursor({ x: 10, y: 0 }); assert.deepEqual(editor.formatting, large);
  editor.setCursor({ x: 12, y: 0 }); assert.equal(editor.formatting.bold, false);
  editor.toggleStyle("italic"); editor.enter(); editor.insertText("B");
  assert.equal(editor.document.getStyle(0, 2).italic, true);
  assert.equal(editor.document.getStyle(0, 2).fontSize, 2);
});

test("uniform and mixed toolbar properties track selections and size edits are one undo batch", () => {
  const editor = new EditorModel();
  editor.applyStyle(large); editor.insertText("AB");
  editor.applyStyle({ ...large, fontSize: 1, italic: true }); editor.insertText("CD");
  select(editor, 0, 6, 0, 2);
  assert.deepEqual(editor.formatting, { bold: true, italic: null, underline: false, strikethrough: false, fontSize: null });
  editor.toggleStyle("italic"); assert.equal(editor.formatting.italic, true);
  const before = exportJson(editor.document, [], camera);
  editor.applyStyle({ fontSize: 3 });
  assert.equal(editor.formatting.fontSize, 3);
  assert.deepEqual(editor.selection, { x1: 0, y1: 0, x2: 12, y2: 3 });
  assert.equal(editor.document.getCell(9, 0), "D"); disjoint(editor);
  editor.undo(); assert.equal(exportJson(editor.document, [], camera), before);
  assert.equal(editor.formatting.fontSize, null);
  editor.redo(); assert.equal(editor.formatting.fontSize, 3);
});

test("partially selected large glyphs are excluded on all four boundaries", () => {
  for (const s of [
    { x1: 1, x2: 4, y1: 0, y2: 2 }, { x1: 0, x2: 3, y1: 0, y2: 2 },
    { x1: 0, x2: 4, y1: 1, y2: 2 }, { x1: 0, x2: 4, y1: 0, y2: 1 },
  ]) {
    const editor = new EditorModel(); editor.applyStyle(large); editor.insertText("한"); editor.setSelection(s);
    editor.toggleStyle("italic"); editor.deleteSelection();
    assert.equal(editor.document.getCell(0, 0), "한");
    assert.deepEqual(editor.document.getStyle(0, 0), large);
  }
  const editor = new EditorModel(); editor.insertText("한AB");
  select(editor, 1, 4); editor.applyStyle(large);
  assert.deepEqual(editor.document.getStyle(0, 0), DEFAULT_TEXT_STYLE);
  assert.deepEqual(editor.document.getStyle(2, 0), large);
  editor.insertText("Z");
  assert.equal(exportTxt(editor.document), "한Z");
  assert.deepEqual(editor.document.getStyle(2, 0), large);
});

test("mixed-size insertion, deletion, splits and joins preserve styles and nonoverlapping footprints", () => {
  const editor = new EditorModel(); editor.applyStyle(large); editor.insertText("한A");
  editor.applyStyle(small); editor.insertText("A🙂");
  const original = stylesByText(editor);
  editor.setCursor({ x: 6, y: 0 }); editor.enter(); disjoint(editor);
  assert.deepEqual(stylesByText(editor), original);
  editor.backspace(); disjoint(editor); assert.deepEqual(stylesByText(editor), original);
  editor.setCursor({ x: 4, y: 0 }); editor.insertText("B");
  assert.deepEqual(editor.document.getStyle(8, 0), small); disjoint(editor);
  editor.backspace(); assert.deepEqual(stylesByText(editor), original);
  editor.setCursor({ x: 4, y: 0 }); editor.deleteForward();
  assert.deepEqual(editor.document.getStyle(4, 0), small); disjoint(editor);
  editor.undo(); assert.deepEqual(stylesByText(editor), original);
});

test("large multiline input and Enter use occupied row heights and remain reversible", () => {
  const editor = new EditorModel(); editor.applyStyle(large); editor.insertText("AB\nCD\nEF");
  assert.equal(editor.document.getCell(0, 2), "C"); assert.equal(editor.document.getCell(0, 4), "E");
  const before = exportJson(editor.document, [], camera);
  editor.setCursor({ x: 2, y: 0 }); editor.enter();
  assert.equal(editor.document.getCell(0, 2), "B"); assert.equal(editor.document.getCell(0, 4), "C");
  disjoint(editor); editor.backspace(); assert.equal(exportJson(editor.document, [], camera), before);
  editor.setCursor({ x: 0, y: 0 }); editor.applyStyle({ fontSize: 3 }); editor.insertText("Z");
  disjoint(editor); assert.equal(editor.document.getCell(0, 3), "C");
});

test("moves translate enlarged selections by exactly one fixed-grid delta across rows and zooms", () => {
  for (const zoom of [0.05, 0.5, 1, 4]) for (const [dx, dy] of [[7, 3], [-11, -5], [0, 8], [1, 0]]) {
    const editor = new EditorModel(); editor.applyStyle(large); editor.insertText("AB");
    editor.setCursor({ x: 20, y: 10 }); editor.applyStyle({ fontSize: 4 }); editor.insertText("C");
    select(editor, 0, 4, 0, 2);
    const viewport = { width: 480, height: 320 }, cameraAtZoom = { ...camera, zoom };
    const origin = logicalToScreen({ x: 0, y: 0 }, cameraAtZoom, viewport, editor.document);
    // Grab any interior point, including the second physical row of a glyph.
    const grab = logicalToScreen({ x: 3, y: 1 }, cameraAtZoom, viewport, editor.document);
    const focus = screenToCell(grab.x + dx * 12 * zoom + 0.001, grab.y + dy * 24 * zoom + 0.001, cameraAtZoom, viewport, editor.document);
    assert.deepEqual(focus, { x: 3 + dx, y: 1 + dy });
    editor.moveSelection(dx, dy);
    assert.equal(editor.document.getCell(dx, dy), "A"); assert.equal(editor.document.getCell(dx + 2, dy), "B");
    const dropped = logicalToScreen({ x: dx, y: dy }, cameraAtZoom, viewport, editor.document);
    assert.ok(Math.abs(dropped.x - origin.x - dx * 12 * zoom) < 1e-8);
    assert.ok(Math.abs(dropped.y - origin.y - dy * 24 * zoom) < 1e-8);
    assert.equal(editor.document.getCell(20, 10), "C"); disjoint(editor);
  }
});

test("large selection collisions push whole blocks in every direction and overwrite removes intersected glyphs", () => {
  for (const [dx, dy] of [[8, 0], [-8, 0], [0, 8], [0, -8]]) {
    const editor = new EditorModel(); editor.applyStyle(large); editor.insertText("AB");
    editor.setCursor({ x: dx + 1, y: dy + 1 }); editor.applyStyle(small); editor.insertText("XY");
    select(editor, 0, 4, 0, 2); const before = exportJson(editor.document, [], camera);
    editor.moveSelection(dx, dy); disjoint(editor);
    assert.equal(editor.document.getCell(dx, dy), "A");
    assert.deepEqual(stylesByText(editor).filter(([text]) => "XY".includes(text)).map(([, style]) => style), [small, small]);
    editor.undo(); assert.equal(exportJson(editor.document, [], camera), before);
  }
  const editor = new EditorModel(); editor.insertText("A"); editor.setCursor({ x: 4, y: 0 }); editor.applyStyle(large); editor.insertText("한");
  select(editor, 0, 1); editor.toggleOverwriteMode(); editor.moveSelection(6, 1);
  assert.equal(editor.document.getCell(4, 0), null); assert.equal(editor.document.getCell(6, 1), "A");
});

test("wrapping measures physical widths and heights and growth restores text and formatting", () => {
  const editor = new EditorModel(); editor.applyStyle(large); editor.insertText("AB");
  editor.applyStyle(DEFAULT_TEXT_STYLE); editor.insertText("cdef"); select(editor, 0, 8, 0, 2);
  const before = stylesByText(editor);
  editor.resizeSelectionHorizontal("right", 4);
  assert.equal(editor.document.getCell(2, 0), "B"); assert.equal(editor.document.getCell(0, 2), "c");
  assert.equal(editor.document.getCell(3, 2), "f"); assert.equal(editor.selection?.y2, 3);
  assert.equal(editor.copySelection(), "AB\ncdef"); disjoint(editor);
  editor.toggleStyle("underline"); editor.resizeSelectionHorizontal("right", 8);
  assert.deepEqual(stylesByText(editor), before.map(([text, style]) => [text, { ...style, underline: true }]));
  assert.equal(editor.selection?.y2, 2); assert.equal(editor.copySelection(), "ABcdef"); disjoint(editor);
});

test("JSON, clones, dirty snapshots and rich clipboard preserve multipliers across negative chunks", () => {
  const editor = new EditorModel(); editor.setCursor({ x: -65, y: -2 }); editor.applyStyle(large); editor.insertText("A한");
  editor.applyStyle(small); editor.insertText("🙂 Z");
  const json = exportJson(editor.document, [], camera); assert.equal(JSON.parse(json).version, 3);
  const loaded = importJson(json).document;
  assert.equal(exportJson(loaded, [], camera), json); assert.equal(exportJson(loaded.cloneClean(), [], camera), json);
  editor.document.markSaved(editor.document.dirtySnapshot());
  select(editor, -65, -55, -2, 0); editor.toggleStyle("underline");
  const snapshot = new IndexedDocumentStorage().createSnapshot(editor.document, camera, []);
  assert.equal(snapshot.meta.gridVersion, 3); assert.ok(snapshot.chunks.some((chunk) => chunk.value?.styles?.length));
  const text = editor.copySelection(); const rich = copyRichText(editor); const pasted = new EditorModel();
  pasted.insertText(text, readRichText(rich, text));
  assert.deepEqual(stylesByText(pasted), stylesByText(editor));
  assert.equal(readRichText(rich, "different"), undefined);
  assert.equal(readRichText('{"version":2,"text":"A","styles":[[0,{}]]}', "A"), undefined);
});

test("legacy pixel sizes migrate once to natural sizes and fixed coordinates without losing text", () => {
  const chunks = [{ x: 0, y: 0, cells: [[0, "A"], [1, "한"], [3, "B"], [64, "C"]] as Array<[number, string]>,
    styles: [[0, { ...large, fontSize: 38 }], [1, { ...large, fontSize: 38 }], [3, { ...small, fontSize: 12 }]] as Array<[number, TextStyle]> }];
  const editor = new EditorModel();
  editor.document = importJson(JSON.stringify({ version: 2, chunkSize: 64, chunks, camera, bookmarks: [] })).document;
  assert.equal(editor.document.getCell(2, 0), "한"); assert.equal(editor.document.getCell(6, 0), "B");
  assert.equal(editor.document.getCell(0, 2), "C"); assert.equal(editor.document.getStyle(6, 0).fontSize, 1); disjoint(editor);
  const json = exportJson(editor.document, [], camera); assert.equal(exportJson(importJson(json).document, [], camera), json);
  const stored = SparseDocument.fromChunks(chunks, true, true);
  assert.equal(exportJson(stored, [], camera), json); assert.ok(stored.isDirty);
  const styles = readRichText(JSON.stringify({ version: 1, text: "A", styles: [[0, { ...large, fontSize: 38 }]] }), "A");
  assert.deepEqual(styles?.get(0), large);
});

test("invalid file styles and unsafe enlarged footprints fail atomically", () => {
  const editor = new EditorModel(); editor.insertText("AB"); const before = exportJson(editor.document, [], camera);
  const file = JSON.parse(before);
  for (const styles of [[[0, { ...large, fontSize: 0 }]], [[3, large]], [[0, large], [0, small]], {}]) {
    file.chunks[0].styles = styles; assert.throws(() => importJson(JSON.stringify(file)));
  }
  editor.setCursor({ x: Number.MAX_SAFE_INTEGER - 1, y: 0 }); editor.applyStyle({ fontSize: 3 });
  assert.throws(() => editor.insertText("A")); assert.equal(exportJson(editor.document, [], camera), before);
  const doc = new SparseDocument(); assert.throws(() => doc.setCell(0, Number.MAX_SAFE_INTEGER, "A", large));
  editor.setCursor({ x: 0, y: 0 }); select(editor, 0, 2); editor.applyStyle({ fontSize: 3 });
  const resized = exportJson(editor.document, [], camera);
  assert.throws(() => editor.moveSelection(Number.MAX_SAFE_INTEGER - 3, 0)); assert.equal(exportJson(editor.document, [], camera), resized);
});

test("drawing bounds, hit testing and cursor reveal all use the fixed base grid", () => {
  const editor = new EditorModel(); editor.insertText("A"); editor.applyStyle(large); editor.insertText("한");
  editor.applyStyle(small); editor.insertText("B"); editor.enter(); editor.insertText("C");
  const layout = getTextLayout(editor.document);
  assert.deepEqual(layout.toWorld({ x: 5, y: 0 }), { x: 5, y: 0 });
  assert.deepEqual(layout.caretRect({ x: 1, y: 0 }, large, 2), { x1: 1, x2: 5, y1: 0, y2: 2 });
  for (const zoom of [0.05, 0.5, 1, 4]) {
    const cameraAtZoom = { ...camera, zoom }, viewport = { width: 480, height: 320 };
    for (const p of [{ x: -10, y: -2 }, { x: 1, y: 0 }, { x: 3, y: 1 }, { x: 5, y: 3 }]) {
      const screen = logicalToScreen(p, cameraAtZoom, viewport, editor.document);
      assert.deepEqual(screenToCell(screen.x + 0.001, screen.y + 0.001, cameraAtZoom, viewport, editor.document), p);
    }
    const caret = layout.caretRect({ x: 100, y: 20 }, large), revealed = cameraToReveal(cameraAtZoom, viewport, caret);
    const screen = logicalToScreen({ x: caret.x2, y: caret.y2 }, revealed, viewport);
    assert.ok(screen.x <= viewport.width && screen.y <= viewport.height);
  }
});

test("vertical navigation retains physical x and avoids the interior of enlarged glyphs", () => {
  const editor = new EditorModel(); editor.insertText("ABCDEFGH"); editor.enter();
  editor.applyStyle(large); editor.insertText("🙂AB"); editor.enter(); editor.applyStyle(DEFAULT_TEXT_STYLE); editor.insertText("ABCDEFGH");
  editor.setCursor({ x: 6, y: 0 }); editor.moveCursor(0, 1); assert.deepEqual(editor.cursor, { x: 6, y: 1 });
  editor.moveCursor(0, 1); assert.deepEqual(editor.cursor, { x: 6, y: 3 });
  editor.moveCursor(0, -1); assert.deepEqual(editor.cursor, { x: 6, y: 1 });
  editor.moveCursor(0, -1); assert.deepEqual(editor.cursor, { x: 6, y: 0 });
  editor.setCursor({ x: 2, y: 0 }); editor.moveCursor(0, 1);
  assert.notEqual(editor.document.getRasterCell(editor.cursor.x, editor.cursor.y), "");
});

test("layout cache, clipped visibility and bounds update without changing any grid coordinate", () => {
  const doc = new SparseDocument(); doc.setCell(-65, -1, "A", large); doc.setCell(0, 0, "한", small); doc.setCell(0, 1, "Z");
  const original = getTextLayout(doc); assert.equal(getTextLayout(doc), original);
  for (const edit of [() => doc.setStyle(-65, -1, { ...large, fontSize: 4 }), () => doc.deleteCell(-65, -1), () => doc.setCell(-65, -1, "B", large), () => doc.deleteCell(0, 0), () => doc.setCell(63, -1, "C", small)]) {
    edit(); const cached = getTextLayout(doc), fresh = getTextLayout(doc.cloneClean());
    assert.deepEqual(cached.bounds, fresh.bounds);
    const a: unknown[] = [], b: unknown[] = [], viewport = { x1: -64, x2: 100, y1: 0, y2: 20 };
    cached.forEachVisible(viewport, (glyph) => a.push(glyph)); fresh.forEachVisible(viewport, (glyph) => b.push(glyph));
    assert.deepEqual(a, b); assert.deepEqual(cached.toWorld({ x: 15, y: 1 }), { x: 15, y: 1 });
  }
});

test("fixed screen rectangles select only fully enclosed mixed-size glyphs", () => {
  const editor = new EditorModel(); editor.insertText("abcdefgh"); editor.enter(); editor.applyStyle(large); editor.insertText("ABCD");
  editor.setSelection(getTextLayout(editor.document).selectionFromDrag({ x: 0, y: 0 }, { x: 4, y: 2 }));
  assert.equal(editor.copySelection(), "abcd\nAB"); editor.toggleStyle("underline");
  assert.equal(editor.document.getStyle(3, 0).underline, true); assert.equal(editor.document.getStyle(4, 0).underline, false);
  assert.equal(editor.document.getStyle(2, 1).underline, true); assert.equal(editor.document.getStyle(4, 1).underline, false);
  const text = editor.copySelection(), paste = new EditorModel(); paste.insertText(text, readRichText(copyRichText(editor), text));
  assert.deepEqual(stylesByText(paste), stylesByText(editor).filter(([text]) => "abcdAB".includes(text)));
  editor.deleteSelection(); assert.equal(editor.document.getCell(4, 0), "e"); assert.equal(editor.document.getCell(4, 1), "C");
  editor.undo(); assert.equal(editor.copySelection(), "abcd\nAB");
});

test("search uses actual adjacent mixed-size glyph footprints", () => {
  const editor = new EditorModel(); editor.applyStyle(large); editor.insertText("AB"); editor.applyStyle(small); editor.insertText("한 C");
  assert.deepEqual(editor.search("AB한 C"), [{ x: 0, y: 0 }]);
});

test("random mixed-size edits retain unique styles, disjoint glyphs and exact undo/redo", () => {
  const editor = new EditorModel(); const expected = new Map<string, TextStyle>();
  let seed = 4187, codepoint = 0x4e00;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 160; i++) {
    const before = exportJson(editor.document, [], camera), action = random(6);
    try {
      if (action < 2 || !editor.document.cellCount) {
        const text = String.fromCodePoint(codepoint++), style = { ...DEFAULT_TEXT_STYLE, fontSize: [1, 2, 3, 4][random(4)], bold: !!random(2), italic: !!random(2) };
        editor.setSelection(null); editor.applyStyle(style); editor.insertText(text); expected.set(text, style);
      } else if (action === 2) editor.backspace();
      else if (action === 3) editor.enter();
      else if (action === 4) { select(editor, editor.cursor.x - 8, editor.cursor.x, editor.cursor.y, editor.cursor.y + 4); editor.moveSelection(random(5) - 2, random(3) - 1); }
      else { editor.setSelection(null); editor.setCursor({ x: random(12) - 6, y: random(8) - 4 }); editor.deleteForward(); }
    } catch { assert.equal(exportJson(editor.document, [], camera), before); }
    disjoint(editor);
    for (const [p, text] of editor.document.entries()) assert.deepEqual(editor.document.getStyle(p.x, p.y), expected.get(text), `style lost for ${text}`);
    const after = exportJson(editor.document, [], camera);
    if (after !== before) { editor.undo(); assert.equal(exportJson(editor.document, [], camera), before); editor.redo(); assert.equal(exportJson(editor.document, [], camera), after); }
  }
});

test("resizing preserves detached and staggered text, and only neighboring runs follow row growth", () => {
  const editor = new EditorModel();
  editor.document.setCell(0, 0, "A", { ...large, fontSize: 3 });
  editor.document.setCell(20, 1, "B");
  editor.document.setCell(0, 6, "C"); editor.document.setCell(1, 6, "D");
  editor.document.setCell(0, 7, "E"); editor.document.setCell(40, 7, "F");
  select(editor, 0, 2, 6, 7); editor.applyStyle({ fontSize: 2 });
  assert.equal(editor.document.getCell(20, 1), "B");
  assert.equal(editor.document.getCell(0, 8), "E");
  assert.equal(editor.document.getCell(40, 7), "F"); disjoint(editor);
  editor.applyStyle({ fontSize: 1 });
  assert.equal(editor.document.getCell(0, 7), "E"); assert.equal(editor.document.getCell(20, 1), "B"); disjoint(editor);
});

test("navigation uses the complete mixed-size line height even beside a small last letter", () => {
  const editor = new EditorModel(); editor.applyStyle(large); editor.insertText("A");
  editor.applyStyle(small); editor.insertText("b"); editor.enter(); editor.insertText("xyz");
  editor.setCursor({ x: 3, y: 0 }); editor.moveCursor(0, 1); assert.deepEqual(editor.cursor, { x: 3, y: 2 });
  editor.moveCursor(0, -1); assert.deepEqual(editor.cursor, { x: 3, y: 0 });
  editor.setCursor({ x: 2, y: 0 }); editor.moveCursor(0, 1); assert.deepEqual(editor.cursor, { x: 2, y: 2 });
  editor.moveCursor(0, -1); assert.deepEqual(editor.cursor, { x: 2, y: 0 });
});

test("pulling text beside the lower part of a large glyph cannot create overlaps", () => {
  const editor = new EditorModel(); editor.document.setCell(-2, 6, "한", { ...large, fontSize: 4 });
  editor.document.setCell(6, 5, "A", { ...large, fontSize: 3 }); editor.setCursor({ x: 6, y: 5 });
  const before = exportJson(editor.document, [], camera);
  assert.throws(() => editor.backspace());
  assert.equal(exportJson(editor.document, [], camera), before); disjoint(editor);
});

test("search highlights span every matched glyph's physical width and height", () => {
  const editor = new EditorModel(); editor.applyStyle(large); editor.insertText("AB"); editor.applyStyle(small); editor.insertText("한 C");
  assert.deepEqual(getTextLayout(editor.document).searchRect({ x: 0, y: 0 }, 6), { x1: 0, x2: 8, y1: 0, y2: 2 });
});
