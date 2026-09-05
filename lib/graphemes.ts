import { WIDE_RANGES } from "./wide-ranges";
import { EditorError } from "./types";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const MAX_CELL_CODE_UNITS = 256;

export function hasControlCharacter(
  value: string,
  allowLineFeed = false,
): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      ((code <= 0x1f && !(allowLineFeed && code === 0x0a)) ||
        (code >= 0x7f && code <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

export function segmentGraphemes(value: string): string[] {
  return Array.from(segmenter.segment(value), (part) => part.segment);
}

export function normalizeTextInput(value: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n");
  if (hasControlCharacter(normalized, true)) {
    throw new EditorError("탭과 제어 문자는 입력할 수 없습니다.");
  }
  return normalized;
}

export function isValidCellValue(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CELL_CODE_UNITS ||
    hasControlCharacter(value, false)
  ) {
    return false;
  }
  const graphemes = segmentGraphemes(value);
  return graphemes.length === 1 && graphemes[0] === value;
}

export function assertValidCellValue(value: unknown): asserts value is string {
  if (!isValidCellValue(value)) {
    throw new EditorError("셀 값은 제어 문자가 아닌 문자소 묶음 하나여야 합니다.");
  }
}

// Width belongs to the whole grapheme, never its individual combining marks.
export function graphemeWidth(value: string): 1 | 2 {
  if (/\p{Emoji_Presentation}|\uFE0F|\u20E3/u.test(value)) return 2;
  for (const character of value.normalize("NFC")) {
    if (/\p{Mark}/u.test(character)) continue;
    const code = character.codePointAt(0)!;
    let low = 0;
    let high = WIDE_RANGES.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const [start, end] = WIDE_RANGES[middle];
      if (code < start) high = middle - 1;
      else if (code > end) low = middle + 1;
      else return 2;
    }
  }
  return 1;
}

export function textWidth(value: string): number {
  return segmentGraphemes(value).reduce((width, cell) => width + graphemeWidth(cell), 0);
}
