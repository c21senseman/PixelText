import type { Position, Selection } from "./types";

export type Footprint = Position & { width: number; height: number };
const TILE = 64;
const MAX_INDEX_TILES = 64;

export function intersects(a: Footprint, b: Selection): boolean {
  return a.x < b.x2 && a.x + a.width > b.x1 && a.y < b.y2 && a.y + a.height > b.y1;
}

export function contains(a: Footprint, selection: Selection): boolean {
  return a.x >= selection.x1 && a.y >= selection.y1 && a.x + a.width <= selection.x2 && a.y + a.height <= selection.y2;
}

// Index large glyphs by their footprint, without allocating every covered cell.
// Very large font sizes use a separate sparse list instead of an enormous grid.
export class GlyphCoverage {
  private readonly entries = new Map<string, Footprint>();
  private readonly tiles = new Map<string, Set<string>>();
  private readonly large = new Set<string>();
  get size(): number { return this.entries.size; }

  private tileKeys(rect: Footprint): string[] | null {
    const x1 = Math.floor(rect.x / TILE), x2 = Math.floor((rect.x + rect.width - 1) / TILE);
    const y1 = Math.floor(rect.y / TILE), y2 = Math.floor((rect.y + rect.height - 1) / TILE);
    if ((x2 - x1 + 1) * (y2 - y1 + 1) > MAX_INDEX_TILES) return null;
    const keys: string[] = [];
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) keys.push(`${x},${y}`);
    return keys;
  }

  set(key: string, rect: Footprint | null): void {
    const old = this.entries.get(key);
    if (old) {
      for (const tile of this.tileKeys(old) ?? []) {
        this.tiles.get(tile)?.delete(key);
        if (!this.tiles.get(tile)?.size) this.tiles.delete(tile);
      }
      this.large.delete(key);
      this.entries.delete(key);
    }
    if (!rect) return;
    this.entries.set(key, rect);
    const tiles = this.tileKeys(rect);
    if (!tiles) this.large.add(key);
    else for (const tile of tiles) {
      const values = this.tiles.get(tile) ?? new Set<string>();
      values.add(key); this.tiles.set(tile, values);
    }
  }

  at(x: number, y: number, include: (position: Position) => boolean = () => true): Position | null {
    for (const keys of [this.tiles.get(`${Math.floor(x / TILE)},${Math.floor(y / TILE)}`) ?? [], this.large]) {
      for (const key of keys) {
        const rect = this.entries.get(key)!;
        if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height && include(rect)) return { x: rect.x, y: rect.y };
      }
    }
    return null;
  }

  forEachInRect(selection: Selection, callback: (rect: Footprint) => void): void {
    const keys = this.tileKeys({ x: selection.x1, y: selection.y1, width: selection.x2 - selection.x1, height: selection.y2 - selection.y1 });
    const candidates = keys ? new Set([...keys.flatMap((key) => [...(this.tiles.get(key) ?? [])]), ...this.large]) : this.entries.keys();
    for (const key of candidates) {
      const rect = this.entries.get(key)!;
      if (intersects(rect, selection)) callback(rect);
    }
  }
}
