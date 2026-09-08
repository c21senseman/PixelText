import type { SparseDocument } from "./document";
import { BASE_FONT_SIZE, DEFAULT_TEXT_STYLE, textWidthInCells, type TextStyle } from "./formatting";
import { selectionFromCursorDrag, type Bounds, type Position, type Selection } from "./types";
import { graphemeWidth } from "./graphemes";

export type LayoutGlyph = {
  position: Position;
  text: string;
  style: TextStyle;
  rect: Selection;
};
type LayoutRow = {
  y: number;
  revision: number;
  height: number;
  maxScale: number;
  // Glyph y coordinates are relative to the row, so vertical reflow can reuse
  // unchanged rows without visiting every character in the document.
  glyphs: LayoutGlyph[];
};

export class TextLayout {
  private readonly rows = new Map<number, LayoutRow>();
  private readonly sortedRows: LayoutRow[];
  readonly bounds: Bounds | null;

  constructor(private readonly document: SparseDocument, previous?: TextLayout) {
    for (const y of [...document.rowKeys()].sort((a, b) => a - b)) {
      const revision = document.rowRevision(y);
      const saved = previous?.rows.get(y);
      if (saved?.revision === revision) {
        this.rows.set(y, { ...saved });
        continue;
      }
      const cells = [...document.entriesInRow(y)].map(([position, text]) => ({
        position, text, style: document.getStyle(position.x, y),
      })).sort((a, b) => a.position.x - b.position.x);
      let maxScale = 0;
      for (let i = 0; i < cells.length; i += 1) {
        const cell = cells[i];
        const scale = cell.style.fontSize / BASE_FONT_SIZE;
        maxScale = Math.max(maxScale, scale);
      }
      const height = Math.max(1, Math.ceil(maxScale));
      const glyphs = cells.map((cell) => {
        const scale = cell.style.fontSize / BASE_FONT_SIZE;
        const x = cell.position.x;
        const y = 0;
        return { ...cell, rect: { x1: x, y1: y,
          x2: x + textWidthInCells(cell.text, cell.style), y2: y + scale } };
      });
      this.rows.set(y, { y, revision, height, maxScale, glyphs });
    }
    this.sortedRows = [...this.rows.values()];
    let bounds: Bounds | null = null;
    for (const row of this.sortedRows) {
      if (!row.glyphs.length) continue;
      const x1 = row.glyphs[0].rect.x1;
      const x2 = row.glyphs[row.glyphs.length - 1].rect.x2;
      const y1 = row.y;
      const y2 = y1 + row.maxScale;
      if (!bounds) bounds = { minX: x1, minY: y1, maxX: x2, maxY: y2 };
      else {
        bounds.minX = Math.min(bounds.minX, x1); bounds.minY = Math.min(bounds.minY, y1);
        bounds.maxX = Math.max(bounds.maxX, x2); bounds.maxY = Math.max(bounds.maxY, y2);
      }
    }
    this.bounds = bounds;
  }

  // World units are always the base grid; fonts never warp coordinates.
  toWorld(position: Position): Position { return { ...position }; }
  toLogical(position: Position): Position { return { ...position }; }

  rowHeight(y: number): number { return this.rows.get(y)?.height ?? 1; }

  caretRect(position: Position, style = DEFAULT_TEXT_STYLE, columns = 1): Selection {
    const world = position;
    const scale = style.fontSize / BASE_FONT_SIZE;
    const top = world.y;
    return { x1: world.x, y1: top, x2: world.x + Math.ceil(columns * scale), y2: top + scale };
  }

  searchRect(position: Position, textColumns: number): Selection {
    let x = position.x, height = 1, consumed = 0;
    while (consumed < textColumns && Number.isSafeInteger(x)) {
      const text = this.document.getCell(x, position.y) ?? " ";
      const style = this.document.getStyle(x, position.y);
      consumed += graphemeWidth(text);
      x += textWidthInCells(text, style);
      height = Math.max(height, style.fontSize);
    }
    return { x1: position.x, x2: x, y1: position.y, y2: position.y + height };
  }

  nearestCursorX(worldX: number, y: number): number {
    const x = Math.round(worldX);
    if (!Number.isSafeInteger(x)) return x;
    const anchor = this.document.anchorAt(x, y);
    if (!anchor) return x;
    const rect = this.document.footprint(anchor.x, anchor.y);
    return worldX - rect.x < rect.x + rect.width - worldX ? rect.x : rect.x + rect.width;
  }

  selectionRects(selection: Selection): Selection[] { return [{ ...selection }]; }
  selectionBounds(selection: Selection): Selection { return { ...selection }; }
  selectionFromDrag(anchor: Position, focus: Position): Selection | null {
    return selectionFromCursorDrag(anchor, focus);
  }
  selectionForColumns(left: number, right: number, y1: number, y2: number): Selection {
    return { x1: Math.floor(left), x2: Math.ceil(right), y1, y2 };
  }

  forEachVisible(visible: Selection, callback: (glyph: LayoutGlyph) => void): void {
    this.document.forEachInRect(visible.x1, visible.y1, visible.x2, visible.y2, (x, y, text) => {
      const style = this.document.getStyle(x, y);
      const scale = style.fontSize / BASE_FONT_SIZE;
      const top = y;
      callback({ position: { x, y }, text, style, rect: {
        x1: x, x2: x + textWidthInCells(text, style), y1: top, y2: top + scale,
      } });
    });
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
