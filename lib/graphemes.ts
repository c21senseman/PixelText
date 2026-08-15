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
