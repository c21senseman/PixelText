import type { SparseDocument } from "./document";
import { isGlyphSelected } from "./coverage";
import { contentWidth, type CellContent } from "./formatting";
import type { PlacedCell } from "./grid-placement";
import { assertTextRasterSize, EditorError, MAX_TEXT_CELLS, selectionRowRange, type Selection } from "./types";

// Limit the text produced, rather than the pixel/grid area of large glyphs.
// Continuation columns and rows never become extra characters or blank lines.
export function placedContentRows(cells: PlacedCell[], selection: Selection): Array<{ y: number; cells: Array<CellContent | null> }> {
  const rows = new Map<number, PlacedCell[]>();
  for (const cell of cells) {
    const { x, y } = cell.position;
    if (!isGlyphSelected({ x, y, width: contentWidth(cell.value), height: cell.value.style.fontSize }, selection)) continue;
    const outputY = Math.max(y, selection.y1);
    const row = rows.get(outputY) ?? []; row.push(cell); rows.set(outputY, row);
  }
  const rowKeys = [...rows.keys()].sort((a, b) => a - b);
  const lines: Array<{ y: number; cells: Array<CellContent | null> }> = [];
  let coveredUntil = selection.y1, count = 0, nextRow = 0;
  const reserve = (length: number, rowWidth: number) => {
    count += length;
    assertTextRasterSize(rowWidth, 1);
    assertTextRasterSize(1, lines.length + 1);
    if (count > MAX_TEXT_CELLS) throw new EditorError("변환할 텍스트가 너무 큽니다. 선택을 줄이거나 JSON으로 내보내 주세요.");
  };
  for (let y = selection.y1; y < selection.y2;) {
    while (nextRow < rowKeys.length && rowKeys[nextRow] < y) nextRow++;
    const row = rows.get(y);
    if (!row && y < coveredUntil) { y = Math.min(coveredUntil, rowKeys[nextRow] ?? selection.y2, selection.y2); continue; }
    const range = selectionRowRange(selection, y), line: Array<CellContent | null> = [];
    let x = range.x1;
    for (const cell of (row ?? []).sort((a, b) => a.position.x - b.position.x)) {
      const gap = Math.max(0, cell.position.x - x);
      reserve(gap + 1, line.length + gap + 1);
      for (let i = 0; i < gap; i++) line.push(null);
      line.push(cell.value);
      x = cell.position.x + contentWidth(cell.value);
      coveredUntil = Math.max(coveredUntil, cell.position.y + cell.value.style.fontSize);
    }
    const gap = Math.max(0, range.x2 - x); reserve(gap, line.length + gap);
    for (let i = 0; i < gap; i++) line.push(null);
    lines.push({ y, cells: line }); y++;
  }
  return lines;
}

export function contentRows(document: SparseDocument, selection: Selection): Array<Array<CellContent | null>> {
  const cells: PlacedCell[] = [];
  document.forEachInSelection(selection, (x, y, text) => cells.push({ position: { x, y }, value: { text, style: document.getStyle(x, y) } }), true);
  return placedContentRows(cells, selection).map((row) => row.cells);
}
