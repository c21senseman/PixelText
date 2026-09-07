import type { SparseDocument } from "./document";
import { BASE_FONT_SIZE, DEFAULT_TEXT_STYLE, type TextStyle } from "./formatting";
import { graphemeWidth } from "./graphemes";
import { selectionFromCursorDrag, selectionRowRange, type Bounds, type Position, type Selection } from "./types";

type Span = { start: number; length: number; scale: number };
type AxisSpan = Span & { world: number; delta: number };

function upperBound<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (key(items[mid]) <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

// A sparse, invertible mapping: glyph advances vary, while empty distances keep
// their original spacing. Coordinates and editing transactions remain lossless.
class LayoutAxis {
  private readonly spans: AxisSpan[];

  constructor(spans: Span[]) {
    let delta = 0;
    let end: number | null = null;
    this.spans = [];
    const append = (span: Span) => {
      if (span.scale === 1) return;
      this.spans.push({ ...span, world: span.start + delta, delta });
      delta += span.length * (span.scale - 1);
    };
    for (const span of spans) {
      if (end !== null && span.start - end > 1 && delta !== 0) {
        const gap = span.start - end;
        // Spacious gaps absorb a size change before moving a detached block.
        // Keep at least two base cells when expansion reaches that block.
        const remaining = Math.max(0, delta - gap + 2);
        append({ start: end, length: gap, scale: 1 + (remaining - delta) / gap });
      }
      append(span);
      end = span.start + span.length;
    }
  }

  project(value: number): number {
    const span = this.spans[upperBound(this.spans, value, (s) => s.start) - 1];
    if (!span) return value;
    const used = Math.min(span.length, value - span.start);
    return value + span.delta + used * (span.scale - 1);
  }

  unproject(value: number): number {
    const span = this.spans[upperBound(this.spans, value, (s) => s.world) - 1];
    if (!span) return value;
    const used = Math.min(span.length * span.scale, value - span.world);
    return value - span.delta - used * (1 - 1 / span.scale);
  }
}

export type LayoutGlyph = {
  position: Position;
  text: string;
  style: TextStyle;
  rect: Selection;
};
type LayoutRow = {
  y: number;
  revision: number;
  axis: LayoutAxis;
  height: number;
  maxScale: number;
  worldY: number;
  // Glyph y coordinates are relative to the row, so vertical reflow can reuse
  // unchanged rows without visiting every character in the document.
  glyphs: LayoutGlyph[];
};
const IDENTITY_AXIS = new LayoutAxis([]);

export class TextLayout {
  private readonly rows = new Map<number, LayoutRow>();
  private readonly sortedRows: LayoutRow[];
  private readonly vertical: LayoutAxis;
  readonly bounds: Bounds | null;

  constructor(private readonly document: SparseDocument, previous?: TextLayout) {
    const heights: Span[] = [];
    for (const y of [...document.rowKeys()].sort((a, b) => a - b)) {
      const revision = document.rowRevision(y);
      const saved = previous?.rows.get(y);
      if (saved?.revision === revision) {
        this.rows.set(y, { ...saved });
        heights.push({ start: y, length: 1, scale: saved.height });
        continue;
      }
      const cells = [...document.entriesInRow(y)].map(([position, text]) => ({
        position, text, style: document.getStyle(position.x, y),
      })).sort((a, b) => a.position.x - b.position.x);
      const spans: Span[] = [];
      let maxScale = 0;
      for (let i = 0; i < cells.length; i += 1) {
        const cell = cells[i];
        const scale = cell.style.fontSize / BASE_FONT_SIZE;
        const length = graphemeWidth(cell.text);
        spans.push({ start: cell.position.x, length, scale });
        if (cells[i + 1]?.position.x === cell.position.x + length + 1) {
          spans.push({ start: cell.position.x + length, length: 1, scale });
        }
        maxScale = Math.max(maxScale, scale);
      }
      const height = Math.max(1, maxScale);
      const axis = new LayoutAxis(spans);
      const glyphs = cells.map((cell) => {
        const scale = cell.style.fontSize / BASE_FONT_SIZE;
        const x = axis.project(cell.position.x);
        const y = (height - scale) * 0.8;
        return { ...cell, rect: { x1: x, y1: y,
          x2: x + graphemeWidth(cell.text) * scale, y2: y + scale } };
      });
      this.rows.set(y, { y, revision, axis, height, maxScale, worldY: 0, glyphs });
      heights.push({ start: y, length: 1, scale: height });
    }
    this.vertical = new LayoutAxis(heights);
    this.sortedRows = [...this.rows.values()];
    let bounds: Bounds | null = null;
    for (const row of this.sortedRows) {
      row.worldY = this.vertical.project(row.y);
      if (!row.glyphs.length) continue;
      const x1 = row.glyphs[0].rect.x1;
      const x2 = row.glyphs[row.glyphs.length - 1].rect.x2;
      const y1 = row.worldY + (row.height - row.maxScale) * 0.8;
      const y2 = y1 + row.maxScale;
      if (!bounds) bounds = { minX: x1, minY: y1, maxX: x2, maxY: y2 };
      else {
        bounds.minX = Math.min(bounds.minX, x1); bounds.minY = Math.min(bounds.minY, y1);
        bounds.maxX = Math.max(bounds.maxX, x2); bounds.maxY = Math.max(bounds.maxY, y2);
      }
    }
    this.bounds = bounds;
  }

  toWorld(position: Position): Position {
    return { x: (this.rows.get(Math.floor(position.y))?.axis ?? IDENTITY_AXIS).project(position.x),
      y: this.vertical.project(position.y) };
  }

  toLogical(world: Position): Position {
    const y = this.vertical.unproject(world.y);
    return { x: (this.rows.get(Math.floor(y))?.axis ?? IDENTITY_AXIS).unproject(world.x), y };
  }

  rowHeight(y: number): number { return this.rows.get(y)?.height ?? 1; }

  caretRect(position: Position, style = DEFAULT_TEXT_STYLE, columns = 1): Selection {
    const world = this.toWorld(position);
    const scale = style.fontSize / BASE_FONT_SIZE;
    const height = Math.max(this.rowHeight(position.y), scale);
    const top = world.y + (height - scale) * 0.8;
    return { x1: world.x, y1: top, x2: world.x + columns * scale, y2: top + scale };
  }

  nearestCursorX(worldX: number, y: number): number {
    const x = (this.rows.get(y)?.axis ?? IDENTITY_AXIS).unproject(worldX);
    const candidate = Math.round(x);
    if (!Number.isSafeInteger(candidate)) return candidate;
    const snapped = this.document.snapPosition({ x: candidate, y });
    if (snapped.x === candidate) return candidate;
    const left = this.toWorld(snapped).x;
    const right = this.toWorld({ x: snapped.x + 2, y }).x;
    return worldX - left < right - worldX ? snapped.x : snapped.x + 2;
  }

  selectionRects(selection: Selection): Selection[] {
    const rects: Selection[] = [];
    let y = selection.y1;
    const start = upperBound(this.sortedRows, y - 1, (row) => row.y);
    for (let i = start; i < this.sortedRows.length; i += 1) {
      const row = this.sortedRows[i];
      if (row.y >= selection.y2) break;
      if (row.y > y) rects.push({ x1: selection.x1, x2: selection.x2,
        y1: this.vertical.project(y), y2: this.vertical.project(row.y) });
      const range = selectionRowRange(selection, row.y);
      rects.push({ x1: row.axis.project(range.x1), x2: row.axis.project(range.x2),
        y1: this.vertical.project(row.y), y2: this.vertical.project(row.y + 1) });
      y = row.y + 1;
    }
    if (y < selection.y2) rects.push({ x1: selection.x1, x2: selection.x2,
      y1: this.vertical.project(y), y2: this.vertical.project(selection.y2) });
    return rects;
  }

  selectionFromDrag(anchor: Position, focus: Position): Selection | null {
    const selection = selectionFromCursorDrag(anchor, focus);
    if (!selection) return null;
    const a = this.toWorld(anchor).x;
    const b = this.toWorld(focus).x;
    const left = Math.min(a, b);
    const right = a === b ? left + 1 : Math.max(a, b);
    return this.selectionForColumns(left, right, selection.y1, selection.y2);
  }

  selectionForColumns(left: number, right: number, y1: number, y2: number): Selection {
    const rows: Array<{ y: number; x1: number; x2: number }> = [];
    let minX = Infinity;
    let maxX = -Infinity;
    for (const row of this.sortedRows) {
      if (row.y < y1) continue;
      if (row.y >= y2) break;
      const x1 = Math.ceil(row.axis.unproject(left) - 1e-9);
      const x2 = Math.max(x1, Math.floor(row.axis.unproject(right) + 1e-9));
      rows.push({ y: row.y, x1, x2 });
      minX = Math.min(minX, x1); maxX = Math.max(maxX, x2);
    }
    if (rows.length < y2 - y1 || minX >= maxX) {
      minX = Math.min(minX, Math.floor(left)); maxX = Math.max(maxX, Math.ceil(right));
    }
    return { x1: minX, x2: maxX, y1, y2,
      ...(rows.some((row) => row.x1 !== minX || row.x2 !== maxX) ? { rows } : {}) };
  }

  selectionBounds(selection: Selection): Selection {
    const rects = this.selectionRects(selection);
    return rects.reduce((bounds, r) => ({ x1: Math.min(bounds.x1, r.x1), x2: Math.max(bounds.x2, r.x2),
      y1: Math.min(bounds.y1, r.y1), y2: Math.max(bounds.y2, r.y2) }));
  }

  forEachVisible(visible: Selection, callback: (glyph: LayoutGlyph) => void): void {
    const minY = Math.floor(this.vertical.unproject(visible.y1));
    const maxY = Math.ceil(this.vertical.unproject(visible.y2));
    const start = upperBound(this.sortedRows, minY - 1, (row) => row.y);
    for (let i = start; i < this.sortedRows.length; i += 1) {
      const row = this.sortedRows[i];
      if (row.y > maxY) break;
      const first = upperBound(row.glyphs, visible.x1, (glyph) => glyph.rect.x2);
      for (let j = first; j < row.glyphs.length; j += 1) {
        const glyph = row.glyphs[j];
        if (glyph.rect.x1 >= visible.x2) break;
        callback({ ...glyph, rect: { ...glyph.rect,
          y1: glyph.rect.y1 + row.worldY, y2: glyph.rect.y2 + row.worldY } });
      }
    }
  }
}

const cache = new WeakMap<SparseDocument, { revision: number; layout: TextLayout }>();
export function getTextLayout(document: SparseDocument): TextLayout {
  const saved = cache.get(document);
  if (saved?.revision === document.contentRevision) return saved.layout;
  const layout = new TextLayout(document, saved?.layout);
  cache.set(document, { revision: document.contentRevision, layout });
  return layout;
}
