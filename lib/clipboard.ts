import { selectionRowRange } from "./types";
import type { EditorModel } from "./editor";
import { DEFAULT_TEXT_STYLE, parseTextStyle, sameStyle, type TextStyle } from "./formatting";
import { graphemeWidth, segmentGraphemes } from "./graphemes";
import { MAX_IMPORT_FILE_BYTES } from "./io";

export const RICH_TEXT_MIME = "application/x-pixeltext+json";

export function copyRichText(editor: EditorModel): string {
  const text = editor.copySelection();
  const selection = editor.selection;
  const styles: Array<[number, TextStyle]> = [];
  let offset = 0;
  if (selection) {
    for (let y = selection.y1; y < selection.y2; y += 1) {
      const range = selectionRowRange(selection, y);
      for (let x = range.x1; x < range.x2; x += 1) {
        const value = editor.document.getCell(x, y);
        if (value && x >= range.x1 && x + graphemeWidth(value) <= range.x2) {
          const style = editor.document.getStyle(x, y);
          if (!sameStyle(style, DEFAULT_TEXT_STYLE)) styles.push([offset, style]);
          x += graphemeWidth(value) - 1;
        }
        offset += 1;
      }
    }
  }
  return JSON.stringify({ version: 1, text, styles });
}

// Untrusted clipboard data never overrides the plain text payload. Malformed or
// foreign rich data gracefully falls back to normal insertion formatting.
export function readRichText(raw: string, text: string): ReadonlyMap<number, TextStyle> | undefined {
  if (!raw || raw.length > MAX_IMPORT_FILE_BYTES) return;
  try {
    const value = JSON.parse(raw);
    if (!value || value.version !== 1 || value.text !== text || !Array.isArray(value.styles)) return;
    const count = text.split(/\r\n?|\n/).reduce((sum, line) => sum + segmentGraphemes(line).length, 0);
    const styles = new Map<number, TextStyle>();
    for (const entry of value.styles) {
      if (!Array.isArray(entry) || entry.length !== 2 || !Number.isInteger(entry[0]) ||
        entry[0] < 0 || entry[0] >= count || styles.has(entry[0])) return;
      styles.set(entry[0], parseTextStyle(entry[1]));
    }
    return styles;
  } catch { return; }
}
