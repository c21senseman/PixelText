import type { EditorModel } from "./editor";
import { DEFAULT_TEXT_STYLE, cellStyle, parseTextStyle, parseLegacyTextStyle, sameStyle, type TextStyle } from "./formatting";
import { segmentGraphemes } from "./graphemes";
import { MAX_IMPORT_FILE_BYTES } from "./io";

export const RICH_TEXT_MIME = "application/x-pixeltext+json";

export function copyRichText(editor: EditorModel): string {
  const text = editor.copySelection();
  const styles: Array<[number, TextStyle]> = [];
  let offset = 0;
  for (const row of editor.selectionContent()) for (const cell of row) {
    const style = cell ? cellStyle(cell) : DEFAULT_TEXT_STYLE;
    if (!sameStyle(style, DEFAULT_TEXT_STYLE)) styles.push([offset, style]);
    offset++;
  }
  return JSON.stringify({ version: 2, text, styles });
}

// Untrusted clipboard data never overrides the plain text payload. Malformed or
// foreign rich data gracefully falls back to normal insertion formatting.
export function readRichText(raw: string, text: string): ReadonlyMap<number, TextStyle> | undefined {
  if (!raw || raw.length > MAX_IMPORT_FILE_BYTES) return;
  try {
    const value = JSON.parse(raw);
    if (!value || (value.version !== 1 && value.version !== 2) || value.text !== text || !Array.isArray(value.styles)) return;
    const count = text.split(/\r\n?|\n/).reduce((sum, line) => sum + segmentGraphemes(line).length, 0);
    const styles = new Map<number, TextStyle>();
    for (const entry of value.styles) {
      if (!Array.isArray(entry) || entry.length !== 2 || !Number.isInteger(entry[0]) ||
        entry[0] < 0 || entry[0] >= count || styles.has(entry[0])) return;
      styles.set(entry[0], value.version === 2 ? parseTextStyle(entry[1]) : parseLegacyTextStyle(entry[1]));
    }
    return styles;
  } catch { return; }
}
