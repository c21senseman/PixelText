import { contentWidth, textHeightInCells } from "./formatting";
import { intersects, type Footprint } from "./coverage";
import type { PlacedCell } from "./grid-placement";
import { assertSafePosition, safeAdd, type Position, type Selection } from "./types";

export function footprint(cell: PlacedCell): Footprint {
  return { ...cell.position, width: contentWidth(cell.value), height: textHeightInCells(cell.value.style) };
}
export function cellRect(cell: PlacedCell): Selection {
  const r = footprint(cell);
  return { x1: r.x, y1: r.y, x2: r.x + r.width, y2: r.y + r.height };
}
export function moveCell(cell: PlacedCell, dx: number, dy: number): PlacedCell {
  const position = { x: safeAdd(cell.position.x, dx), y: safeAdd(cell.position.y, dy) };
  const r = footprint({ ...cell, position });
  assertSafePosition({ x: r.x + (r.width - 1), y: r.y + (r.height - 1) });
  return { ...cell, position };
}
function connected(a: Footprint, b: Footprint): boolean {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return (overlapX >= 0 && overlapY >= 0) || (overlapX > 0 && overlapY === -1) || (overlapY > 0 && overlapX === -1);
}
export function connectedCells(cells: PlacedCell[], seeds: PlacedCell[]): Set<PlacedCell> {
  const result = new Set(seeds);
  const queue = [...seeds];
  for (let i = 0; i < queue.length; i++) {
    const current = footprint(queue[i]);
    for (const cell of cells) {
      if (!result.has(cell) && connected(current, footprint(cell))) { result.add(cell); queue.push(cell); }
    }
  }
  return result;
}

export function textRun(cells: PlacedCell[], position: Position): PlacedCell[] {
  const row = cells.filter((cell) => cell.position.y === position.y).sort((a, b) => a.position.x - b.position.x);
  let run: PlacedCell[] = [];
  for (const cell of row) {
    const previous = run.at(-1);
    if (previous && cell.position.x > previous.position.x + contentWidth(previous.value) + 1) {
      if (run[0].position.x <= position.x && position.x <= previous.position.x + contentWidth(previous.value)) return run;
      run = [];
    }
    run.push(cell);
  }
  return run.length && run[0].position.x <= position.x && position.x <= run.at(-1)!.position.x + contentWidth(run.at(-1)!.value) ? run : [];
}

// Move whole blocks by event distances (contact or target exit). A font may
// occupy millions of base cells without requiring millions of single steps.
export function pushOutside(cells: PlacedCell[], targets: Selection[], step: Position): PlacedCell[] {
  let remaining = [...cells];
  const overlaps = (cell: PlacedCell) => targets.some((target) => intersects(footprint(cell), target));
  for (;;) {
    const hit = remaining.find(overlaps);
    if (!hit) return remaining;
    const block = connectedCells(remaining, [hit]);
    let moving = [...block];
    remaining = remaining.filter((cell) => !block.has(cell));
    while (moving.some(overlaps)) {
      const collisions = remaining.filter((cell) => moving.some((item) => intersects(footprint(moveCell(item, step.x, step.y)), cellRect(cell))));
      if (collisions.length) {
        const joined = connectedCells(remaining, collisions);
        moving.push(...joined);
        remaining = remaining.filter((cell) => !joined.has(cell));
        continue;
      }
      let distance = 1;
      for (const item of moving) {
        const r = footprint(item);
        for (const target of targets) if (intersects(r, target)) {
          distance = Math.max(distance, step.x > 0 ? target.x2 - r.x : step.x < 0 ? r.x + r.width - target.x1
            : step.y > 0 ? target.y2 - r.y : r.y + r.height - target.y1);
        }
      }
      for (const item of moving) for (const cell of remaining) {
        const a = footprint(item), b = footprint(cell);
        const across = step.x ? a.y < b.y + b.height && a.y + a.height > b.y : a.x < b.x + b.width && a.x + a.width > b.x;
        if (!across) continue;
        const gap = step.x > 0 ? b.x - (a.x + a.width) : step.x < 0 ? a.x - (b.x + b.width)
          : step.y > 0 ? b.y - (a.y + a.height) : a.y - (b.y + b.height);
        if (gap >= 1) distance = Math.min(distance, gap);
      }
      moving = moving.map((cell) => moveCell(cell, step.x * distance, step.y * distance));
    }
    remaining.push(...moving);
  }
}
