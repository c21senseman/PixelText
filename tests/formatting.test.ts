import assert from "node:assert/strict";
import test from "node:test";
import { EditorModel } from "../lib/editor";
import { SparseDocument } from "../lib/document";
import { DEFAULT_TEXT_STYLE, type TextStyle } from "../lib/formatting";
import { getTextLayout } from "../lib/layout";
import { exportJson, exportTxt, importJson } from "../lib/io";
import { copyRichText, readRichText } from "../lib/clipboard";
import { IndexedDocumentStorage } from "../lib/storage";
import { cameraToReveal, logicalToScreen, screenToCell } from "../lib/renderer";
import { graphemeWidth } from "../lib/graphemes";

const large: TextStyle = { ...DEFAULT_TEXT_STYLE, fontSize: 38, bold: true };
const small: TextStyle = { ...DEFAULT_TEXT_STYLE, fontSize: 12, italic: true, underline: true };
const camera = { x: 0, y: 0, zoom: 1 };
function select(editor: EditorModel, x1: number, x2: number, y1 = 0, y2 = 1) {
  editor.setSelection({ x1, x2, y1, y2 });
}
function stylesByText(editor: EditorModel): Array<[string, TextStyle]> {
  return [...editor.document.entries()].sort((a, b) => a[0].y - b[0].y || a[0].x - b[0].x)
    .map(([p, text]) => [text, editor.document.getStyle(p.x, p.y)]);
}

test("typing style toggles stay pending until input and cursor inheritance uses the whole left grapheme", () => {
  const editor = new EditorModel();
  editor.applyStyle(large);
  assert.equal(editor.canUndo, false);
  assert.equal(editor.document.isDirty, false);
  editor.insertText("A한👩‍💻");
  assert.ok(stylesByText(editor).every(([, style]) => style.fontSize === 38 && style.bold));
  editor.toggleStyle("bold");
  editor.insertText("Z");
  assert.equal(editor.document.getStyle(5, 0).bold, false);
  editor.setCursor({ x: 3, y: 0 });
  assert.deepEqual(editor.formatting, large);
  editor.setCursor({ x: 5, y: 0 });
  assert.deepEqual(editor.formatting, large);
  editor.setCursor({ x: 6, y: 0 });
  assert.equal(editor.formatting.bold, false);
  editor.toggleStyle("italic");
  editor.enter();
  editor.insertText("B");
  assert.equal(editor.document.getStyle(0, 1).italic, true);
  assert.equal(editor.document.getStyle(0, 1).fontSize, 38);
});

test("each toolbar property reports uniform or mixed independently, and mixed toggles apply to all", () => {
  const editor = new EditorModel();
  editor.applyStyle(large); editor.insertText("AB");
  editor.applyStyle({ ...large, fontSize: 19, italic: true }); editor.insertText("CD");
  select(editor, 0, 4);
  assert.deepEqual(editor.formatting, { bold: true, italic: null, underline: false, strikethrough: false, fontSize: null });
  editor.toggleStyle("italic");
  assert.equal(editor.formatting.italic, true);
  assert.equal(editor.formatting.fontSize, null);
  editor.applyStyle({ fontSize: 28 });
  assert.equal(editor.formatting.fontSize, 28);
  assert.equal(editor.document.getStyle(2, 0).bold, true);
  assert.deepEqual(editor.selection, { x1: 0, y1: 0, x2: 4, y2: 1 });
  editor.undo(); assert.equal(editor.formatting.fontSize, null);
  editor.undo(); assert.equal(editor.formatting.italic, null);
  editor.redo(); assert.equal(editor.formatting.italic, true);
});

test("formatting excludes partially selected wide characters, and replacement uses uniform selection style", () => {
  const editor = new EditorModel();
  editor.insertText("한AB");
  select(editor, 1, 4); editor.applyStyle(large);
  assert.deepEqual(editor.document.getStyle(0, 0), DEFAULT_TEXT_STYLE);
  assert.deepEqual(editor.document.getStyle(2, 0), large);
  editor.setCursor({ x: 1, y: 0 });
  select(editor, 2, 4);
  editor.insertText("Z");
  assert.equal(exportTxt(editor.document), "한Z");
  assert.deepEqual(editor.document.getStyle(2, 0), large);
});

test("insertion, deletion, line splits and joins preserve distinct styles of repeated text", () => {
  const editor = new EditorModel();
  editor.applyStyle(large); editor.insertText("한A");
  editor.applyStyle(small); editor.insertText("A🙂");
  const original = stylesByText(editor);
  editor.setCursor({ x: 3, y: 0 }); editor.enter();
  assert.deepEqual(stylesByText(editor), original);
  editor.backspace();
  assert.deepEqual(stylesByText(editor), original);
  editor.setCursor({ x: 2, y: 0 }); editor.insertText("B");
  assert.deepEqual(editor.document.getStyle(4, 0), small);
  editor.backspace();
  assert.deepEqual(stylesByText(editor), original);
  editor.setCursor({ x: 2, y: 0 }); editor.deleteForward();
  assert.deepEqual(editor.document.getStyle(2, 0), small);
  editor.undo(); assert.deepEqual(stylesByText(editor), original);
  editor.undo(); editor.redo(); assert.deepEqual(stylesByText(editor), original);
});

test("selection moves, collision chains and reflow retain formatting through undo and redo", () => {
  const editor = new EditorModel();
  editor.applyStyle(large); editor.insertText("ABCD");
  editor.setCursor({ x: 8, y: 0 }); editor.applyStyle(small); editor.insertText("XY");
  select(editor, 0, 4); editor.moveSelection(8, 0);
  assert.deepEqual(editor.document.getStyle(8, 0), large);
  assert.deepEqual(editor.document.getStyle(12, 0), small);
  editor.resizeSelectionHorizontal("right", 10);
  editor.applyStyle({ underline: true });
  editor.resizeSelectionHorizontal("right", 12);
  for (const [p, value] of editor.document.entries()) {
    if ("ABCD".includes(value)) assert.deepEqual(editor.document.getStyle(p.x, p.y), { ...large, underline: true });
    else assert.deepEqual(editor.document.getStyle(p.x, p.y), small);
  }
  const final = exportJson(editor.document, [], camera);
  editor.undo(); editor.undo(); editor.redo(); editor.redo();
  assert.equal(exportJson(editor.document, [], camera), final);
});

test("JSON, clean clones, dirty save snapshots and rich clipboard retain styles across negative chunks", () => {
  const editor = new EditorModel();
  editor.setCursor({ x: -65, y: -2 }); editor.applyStyle(large); editor.insertText("A한");
  editor.applyStyle(small); editor.insertText("🙂 Z");
  const json = exportJson(editor.document, [], camera);
  assert.equal(JSON.parse(json).version, 2);
  const loaded = importJson(json).document;
  assert.equal(exportJson(loaded, [], camera), json);
  assert.equal(exportJson(loaded.cloneClean(), [], camera), json);
  editor.document.markSaved(editor.document.dirtySnapshot());
  select(editor, -65, -62, -2, -1); editor.toggleStyle("underline");
  const snapshot = new IndexedDocumentStorage().createSnapshot(editor.document, camera, []);
  assert.ok(snapshot.chunks.some((chunk) => chunk.value?.styles?.length));
  select(editor, -65, -58, -2, -1);
  const text = editor.copySelection();
  const rich = copyRichText(editor);
  const pasted = new EditorModel();
  pasted.insertText(text, readRichText(rich, text));
  assert.deepEqual(stylesByText(pasted), stylesByText(editor));
  assert.equal(readRichText(rich, "different"), undefined);
  assert.equal(readRichText('{"version":1,"text":"A","styles":[[0,{}]]}', "A"), undefined);
});

test("invalid font sizes and malformed file styles fail without partially changing a document or history", () => {
  const editor = new EditorModel(); editor.insertText("AB"); select(editor, 0, 2);
  const before = exportJson(editor.document, [], camera);
  for (const fontSize of [0, 7, 97, 19.5, Infinity, NaN]) {
    assert.throws(() => editor.applyStyle({ fontSize }));
    assert.equal(exportJson(editor.document, [], camera), before);
  }
  const file = JSON.parse(before);
  for (const styles of [[[0, { ...large, fontSize: 100 }]], [[3, large]], [[0, large], [0, small]], {}]) {
    file.chunks[0].styles = styles;
    assert.throws(() => importJson(JSON.stringify(file)));
  }
  editor.setSelection(null); editor.setCursor({ x: Number.MAX_SAFE_INTEGER, y: 0 });
  const typing = editor.typingStyle;
  assert.throws(() => editor.insertText("AB", new Map([[0, large]])));
  assert.deepEqual(editor.typingStyle, typing);
  assert.equal(exportJson(editor.document, [], camera), before);
});

test("clipboard grapheme indexes retain line boundaries and overwrite reveal includes a large wide glyph", () => {
  const text = "🇰\n🇷";
  const styles = readRichText(JSON.stringify({ version: 1, text, styles: [[1, large]] }), text);
  assert.deepEqual(styles?.get(1), large);
  const editor = new EditorModel();
  editor.applyStyle(large); editor.insertText("한"); editor.setCursor({ x: 0, y: 0 });
  editor.applyStyle(small); editor.toggleOverwriteMode();
  assert.equal(editor.cursorBounds.x2 - editor.cursorBounds.x1, 4);
  assert.equal(editor.cursorBounds.y2 - editor.cursorBounds.y1, 2);
});

test("mixed font advances, shared baselines and row heights drive drawing, hit testing and cursor reveal", () => {
  const editor = new EditorModel(); editor.insertText("A");
  editor.applyStyle(large); editor.insertText("한");
  editor.applyStyle(small); editor.insertText("B");
  editor.enter(); editor.insertText("C");
  const layout = getTextLayout(editor.document);
  assert.deepEqual(layout.toWorld({ x: 3, y: 0 }), { x: 5, y: 0 });
  assert.equal(layout.toWorld({ x: 0, y: 1 }).y, 2);
  const a = layout.caretRect({ x: 0, y: 0 }, DEFAULT_TEXT_STYLE);
  const han = layout.caretRect({ x: 1, y: 0 }, large, 2);
  assert.equal(a.y1 + (a.y2 - a.y1) * 0.8, han.y1 + (han.y2 - han.y1) * 0.8);
  assert.equal(han.x2 - han.x1, 4);
  for (const zoom of [0.05, 0.5, 1, 4]) {
    const cameraAtZoom = { ...camera, zoom };
    const viewport = { width: 480, height: 320 };
    for (const position of [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 1 }]) {
      const screen = logicalToScreen(position, cameraAtZoom, viewport, editor.document);
      assert.deepEqual(screenToCell(screen.x + 0.01, screen.y + 0.01, cameraAtZoom, viewport, editor.document), position);
    }
    const caret = layout.caretRect({ x: 100, y: 20 }, large);
    const revealed = cameraToReveal(cameraAtZoom, viewport, caret);
    const screen = logicalToScreen({ x: caret.x2, y: caret.y2 }, revealed, viewport);
    assert.ok(screen.x <= viewport.width && screen.y <= viewport.height);
  }
});

test("vertical navigation retains visual x across small and large rows and never splits an emoji", () => {
  const editor = new EditorModel();
  editor.insertText("ABCDEFGH"); editor.enter();
  editor.applyStyle(large); editor.insertText("🙂AB"); editor.enter();
  editor.applyStyle(DEFAULT_TEXT_STYLE); editor.insertText("ABCDEFGH");
  editor.setCursor({ x: 6, y: 0 });
  editor.moveCursor(0, 1); assert.deepEqual(editor.cursor, { x: 3, y: 1 });
  editor.moveCursor(0, 1); assert.deepEqual(editor.cursor, { x: 6, y: 2 });
  editor.moveCursor(0, -1); assert.deepEqual(editor.cursor, { x: 3, y: 1 });
  editor.moveCursor(0, -1); assert.deepEqual(editor.cursor, { x: 6, y: 0 });
  editor.setCursor({ x: 2, y: 0 }); editor.moveCursor(0, 1);
  assert.notEqual(editor.document.getRasterCell(editor.cursor.x, editor.cursor.y), "");
});

test("layout cache invalidates on style-only edits, history and chunk loading", () => {
  const doc = new SparseDocument(); doc.setCell(0, 0, "A");
  const first = getTextLayout(doc);
  assert.equal(getTextLayout(doc), first);
  doc.setStyle(0, 0, large);
  assert.notEqual(getTextLayout(doc), first);
  assert.equal(getTextLayout(doc).toWorld({ x: 1, y: 0 }).x, 2);
  const fresh = new SparseDocument(); const empty = getTextLayout(fresh);
  fresh.loadChunk(doc.sortedChunks()[0]);
  assert.notEqual(getTextLayout(fresh), empty);
  assert.equal(getTextLayout(fresh).toWorld({ x: 1, y: 0 }).x, 2);
});

test("size changes consume nearby space before displacing distant text", () => {
  const doc = new SparseDocument();
  doc.setCell(-4, -2, "A", large);
  doc.setCell(20, -2, "B");
  doc.setCell(20, 30, "C");
  const layout = getTextLayout(doc);
  assert.deepEqual(layout.toWorld({ x: 20, y: 30 }), { x: 20, y: 30 });
  assert.deepEqual(layout.toWorld({ x: 20, y: -2 }), { x: 20, y: -2 });
  for (const x of [-5, -4, -3, 0, 2, 15, 20, 30]) {
    const world = layout.toWorld({ x, y: -2 });
    assert.ok(Math.abs(layout.toLogical(world).x - x) < 1e-8);
  }
});

test("incremental layout matches a fresh rebuild after row height changes, deletion and restoration", () => {
  const doc = new SparseDocument();
  doc.setCell(-65, -1, "A", large); doc.setCell(0, 0, "한", small); doc.setCell(0, 1, "Z");
  const original = getTextLayout(doc);
  const originalWorld = original.toWorld({ x: 0, y: 1 });
  for (const edit of [
    () => doc.setStyle(-65, -1, { ...large, fontSize: 76 }),
    () => doc.deleteCell(-65, -1),
    () => doc.setCell(-65, -1, "B", large),
    () => doc.deleteCell(0, 0),
    () => doc.setCell(63, -1, "C", small),
  ]) {
    edit();
    const cached = getTextLayout(doc);
    const fresh = getTextLayout(doc.cloneClean());
    assert.deepEqual(cached.bounds, fresh.bounds);
    const cachedGlyphs: unknown[] = [];
    const freshGlyphs: unknown[] = [];
    const viewport = { x1: -100, x2: 100, y1: -20, y2: 20 };
    cached.forEachVisible(viewport, (glyph) => cachedGlyphs.push(glyph));
    fresh.forEachVisible(viewport, (glyph) => freshGlyphs.push(glyph));
    assert.deepEqual(cachedGlyphs, freshGlyphs);
  }
  assert.deepEqual(original.toWorld({ x: 0, y: 1 }), originalWorld);
});

test("screen rectangle selects different column counts in mixed-size rows without selecting outside glyphs", () => {
  const editor = new EditorModel();
  editor.insertText("abcdefgh"); editor.enter();
  editor.applyStyle(large); editor.insertText("ABCD");
  const layout = getTextLayout(editor.document);
  const selection = layout.selectionFromDrag({ x: 0, y: 0 }, { x: 2, y: 1 });
  assert.ok(selection);
  editor.setSelection(selection);
  assert.equal(editor.copySelection(), "abcd\nAB");
  editor.toggleStyle("underline");
  assert.equal(editor.document.getStyle(3, 0).underline, true);
  assert.equal(editor.document.getStyle(4, 0).underline, false);
  assert.equal(editor.document.getStyle(1, 1).underline, true);
  assert.equal(editor.document.getStyle(2, 1).underline, false);
  const text = editor.copySelection();
  const paste = new EditorModel();
  paste.insertText(text, readRichText(copyRichText(editor), text));
  assert.deepEqual(stylesByText(paste), stylesByText(editor).filter(([text]) => "abcdAB".includes(text)));
  editor.deleteSelection();
  assert.equal(editor.document.getCell(4, 0), "e");
  assert.equal(editor.document.getCell(2, 1), "C");
  assert.equal(editor.document.getCell(1, 1), null);
  editor.undo(); assert.equal(editor.copySelection(), "abcd\nAB");
});

test("wrapping measures font advances, fits more small letters, and growing restores original text and styles", () => {
  const editor = new EditorModel();
  editor.applyStyle(large); editor.insertText("AB");
  editor.applyStyle(DEFAULT_TEXT_STYLE); editor.insertText("cdef");
  select(editor, 0, 6);
  const before = stylesByText(editor);
  editor.resizeSelectionHorizontal("right", 2, 4);
  assert.equal(editor.document.getCell(0, 0), "A");
  assert.equal(editor.document.getCell(1, 0), "B");
  assert.equal(editor.document.getCell(0, 1), "c");
  assert.equal(editor.document.getCell(3, 1), "f");
  assert.equal(editor.selection?.y2, 2);
  assert.equal(editor.copySelection(), "AB\ncdef");
  editor.resizeSelectionHorizontal("right", 6, 8);
  assert.deepEqual(stylesByText(editor), before);
  assert.equal(editor.selection?.y2, 1);
  assert.equal(editor.copySelection(), "ABcdef");
});

test("random edits preserve style identity, whole glyphs and exact undo across mixed font sizes", () => {
  const editor = new EditorModel();
  const expected = new Map<string, TextStyle>();
  let seed = 4187;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  let codepoint = 0x4e00;
  for (let i = 0; i < 120; i += 1) {
    const before = exportJson(editor.document, [], camera);
    const cursor = { ...editor.cursor };
    const selection = editor.selection;
    const action = random(6);
    try {
      if (action < 2 || !editor.document.cellCount) {
        const text = String.fromCodePoint(codepoint++);
        const style = { ...DEFAULT_TEXT_STYLE, fontSize: [12, 19, 28, 38][random(4)], bold: !!random(2), italic: !!random(2) };
        editor.setSelection(null); editor.applyStyle(style); editor.insertText(text);
        expected.set(text, style);
      } else if (action === 2) editor.backspace();
      else if (action === 3) editor.enter();
      else if (action === 4) {
        select(editor, editor.cursor.x - 4, editor.cursor.x, editor.cursor.y, editor.cursor.y + 1);
        editor.moveSelection(random(5) - 2, random(3) - 1);
      } else {
        editor.setSelection(null); editor.setCursor({ x: random(8) - 4, y: random(6) - 2 }); editor.deleteForward();
      }
    } catch {
      assert.equal(exportJson(editor.document, [], camera), before);
    }
    for (const [p, text] of editor.document.entries()) {
      assert.deepEqual(editor.document.getStyle(p.x, p.y), expected.get(text), `style lost for ${text}`);
      if (graphemeWidth(text) === 2) assert.equal(editor.document.getCell(p.x + 1, p.y), null);
    }
    const after = exportJson(editor.document, [], camera);
    if (after !== before) {
      editor.undo(); assert.equal(exportJson(editor.document, [], camera), before);
      editor.redo(); assert.equal(exportJson(editor.document, [], camera), after);
    } else if (!editor.selection && !selection) {
      // Keep the random walk close to existing content.
      if (Math.abs(editor.cursor.x) > 20) editor.setCursor(cursor);
    }
  }
});
