import assert from "node:assert/strict";
import test from "node:test";
import { SparseDocument } from "../lib/document";
import { DEFAULT_TEXT_STYLE, textWidthInCells } from "../lib/formatting";

function fullCount(document: SparseDocument): number {
  let count = document.storedCellCount;
  for (const [p, text] of document.entries()) {
    const end = p.x + textWidthInCells(text, document.getStyle(p.x, p.y));
    if (Number.isSafeInteger(end + 1) && document.getCell(end, p.y) === null && document.getCell(end + 1, p.y) !== null) count++;
  }
  return count;
}

test("character counts track cross-chunk gaps, widths, deleted rows and loaded chunks", () => {
  const document = new SparseDocument();
  const edits = [
    () => document.setCell(-65, -1, "A"),
    () => document.setCell(-63, -1, "B"),
    () => document.setCell(63, 64, "한"),
    () => document.setCell(66, 64, "Z"),
    () => document.setStyle(-65, -1, { ...DEFAULT_TEXT_STYLE, fontSize: 2 }),
    () => document.setStyle(-65, -1, DEFAULT_TEXT_STYLE),
    () => document.deleteCell(-65, -1),
    () => document.deleteCell(-63, -1),
    () => document.setCell(-65, -1, "X"),
    () => document.loadChunk({ x: 3, y: -2, cells: [[0, "A"], [2, "B"]] }),
    () => document.setCell(Number.MAX_SAFE_INTEGER, 0, "A"),
    () => document.markAllDirty(),
  ];
  for (const edit of edits) {
    edit();
    assert.equal(document.cellCount, fullCount(document));
    assert.equal(document.cellCount, document.cloneClean().cellCount);
  }
  for (const [p] of document.entries()) document.deleteCell(p.x, p.y);
  assert.equal(document.cellCount, 0);
});

test("character counting revisits only edited rows and batches repeated edits", (t) => {
  const document = new SparseDocument();
  for (let y = 0; y < 100; y++) {
    document.setCell(0, y, "A");
    document.setCell(2, y, "B");
  }
  assert.equal(document.cellCount, 300);
  const rows = t.mock.method(document, "entriesInRow");
  document.setCell(1, 42, "C");
  document.deleteCell(2, 42);
  assert.equal(document.cellCount, 299);
  assert.deepEqual(rows.mock.calls.map((call) => call.arguments), [[42]]);
  void document.cellCount;
  document.markAllDirty();
  assert.equal(document.cellCount, 299);
  assert.equal(rows.mock.callCount(), 1);
});

test("incremental counts match full counts through mixed batches of edits", () => {
  const document = new SparseDocument();
  let seed = 731;
  const random = (limit: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % limit; };
  for (let batch = 0; batch < 100; batch++) {
    for (let edit = 0; edit < 10; edit++) {
      const x = random(160) - 80, y = random(9) - 4;
      document.setCell(x, y, ["A", "한", null, " "][random(4)],
        { ...DEFAULT_TEXT_STYLE, fontSize: random(4) + 1 });
    }
    assert.equal(document.cellCount, fullCount(document));
  }
});
