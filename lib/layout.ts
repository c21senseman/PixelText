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
  revision: number;
  height: number;
  bounds: Bounds;
};

export class TextLayout {
  private readonly rows = new Map<number, LayoutRow>();
  readonly bounds: Bounds | null;

  constructor(private readonly document: SparseDocument, previous?: TextLayout) {
    for (const y of document.rowKeys()) {
      const revision = document.rowRevision(y);
      const saved = previous?.rows.get(y);
      if (saved?.revision === revision) {
        this.rows.set(y, saved);
        continue;
      }
      // Rendering queries the document's spatial index directly. Retain only
      // row metrics here instead of a second copy of every glyph and style.
      let maxScale = 0;
      let minX = Infinity;
      let maxX = -Infinity;
      for (const [position, text] of document.entriesInRow(y)) {
        const style = document.getStyle(position.x, y);
        const scale = style.fontSize / BASE_FONT_SIZE;
        maxScale = Math.max(maxScale, scale);
        minX = Math.min(minX, position.x);
        maxX = Math.max(maxX, position.x + textWidthInCells(text, style));
      }
      const height = Math.max(1, Math.ceil(maxScale));
      this.rows.set(y, { revision, height,
        bounds: { minX, minY: y, maxX, maxY: y + maxScale } });
    }
    let bounds: Bounds | null = null;
    for (const row of this.rows.values()) {
      if (!bounds) bounds = { ...row.bounds };
      else {
        bounds.minX = Math.min(bounds.minX, row.bounds.minX); bounds.minY = Math.min(bounds.minY, row.bounds.minY);
        bounds.maxX = Math.max(bounds.maxX, row.bounds.maxX); bounds.maxY = Math.max(bounds.maxY, row.bounds.maxY);
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
