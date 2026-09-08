import { contentWidth, textHeightInCells, type StyledCell } from "./formatting";
import { intersects } from "./coverage";
import { graphemeWidth } from "./graphemes";
import { assertSafePosition, type Position } from "./types";

export type PlacedCell = { position: Position; value: StyledCell };
export type Placement = PlacedCell & { from: Position };
type Run = { oldX1: number; oldX2: number; oldBottom: number; bottom: number; cells: Placement[] };

// Resize anchors on the fixed grid. Only adjacent text follows a resized run;
// detached text consumes its surrounding space before it needs to move.
export function placeResizedText(cells: PlacedCell[], update: (cell: PlacedCell) => StyledCell, legacy = false): Placement[] {
  const oldWidth = (cell: PlacedCell) => legacy ? graphemeWidth(cell.value.text) : contentWidth(cell.value);
  const oldHeight = (cell: PlacedCell) => legacy ? 1 : textHeightInCells(cell.value.style);
  const rows = new Map<number, PlacedCell[]>();
  for (const cell of cells) {
    const row = rows.get(cell.position.y) ?? [];
    row.push(cell); rows.set(cell.position.y, row);
  }
  const runs: Run[] = [];
  for (const [y, row] of [...rows].sort((a, b) => a[0] - b[0])) {
    const groups: PlacedCell[][] = [];
    for (const cell of row.sort((a, b) => a.position.x - b.position.x)) {
      const group = groups.at(-1), last = group?.at(-1);
      if (last && cell.position.x - last.position.x - oldWidth(last) <= 1) group!.push(cell);
      else groups.push([cell]);
    }
    let previousEnd = Number.NEGATIVE_INFINITY;
    for (const group of groups) {
      const first = group[0], last = group.at(-1)!;
      const oldX1 = first.position.x, oldX2 = last.position.x + oldWidth(last);
      const oldBottom = y + group.reduce((max, cell) => Math.max(max, oldHeight(cell)), 1);
      let oldEnd = oldX1, newEnd = Math.max(oldX1, previousEnd + 2);
      const placed = group.map((cell) => {
        const value = update(cell);
        const x = newEnd + (cell.position.x - oldEnd);
        oldEnd = cell.position.x + oldWidth(cell);
        newEnd = x + contentWidth(value);
        return { from: cell.position, position: { x, y }, value };
      });
      previousEnd = newEnd;
      let delta: number | null = null;
      for (const previous of runs) {
        const gap = y - previous.oldBottom;
        if (gap >= 0 && gap <= 1 && oldX1 <= previous.oldX2 && oldX2 >= previous.oldX1) {
          const shift = previous.bottom - previous.oldBottom;
          delta = delta === null ? shift : Math.max(delta, shift);
        }
      }
      let newY = y + (delta ?? 0);
      // Staggered text and disconnected paragraphs move only on real contact.
      for (;;) {
        let nextY = newY;
        for (const cell of placed) for (const previous of runs) for (const other of previous.cells) {
          if (intersects({ x: cell.position.x, y: newY, width: contentWidth(cell.value), height: textHeightInCells(cell.value.style) }, {
            x1: other.position.x, x2: other.position.x + contentWidth(other.value),
            y1: other.position.y, y2: other.position.y + textHeightInCells(other.value.style),
          })) nextY = Math.max(nextY, other.position.y + textHeightInCells(other.value.style));
        }
        if (nextY === newY) break;
        newY = nextY;
      }
      for (const cell of placed) {
        cell.position.y = newY;
        assertSafePosition(cell.position);
        assertSafePosition({ x: cell.position.x + (contentWidth(cell.value) - 1), y: newY + (textHeightInCells(cell.value.style) - 1) });
      }
      runs.push({ oldX1, oldX2, oldBottom, bottom: newY + placed.reduce((max, cell) => Math.max(max, textHeightInCells(cell.value.style)), 1), cells: placed });
    }
  }
  return runs.flatMap((run) => run.cells);
}
