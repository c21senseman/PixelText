import { EditorError } from "./types";

export const BASE_FONT_SIZE = 19;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 96;
export const FONT_SIZES = [8, 10, 12, 14, 16, 19, 24, 28, 32, 38, 48, 64, 76, 96];

export type TextStyle = Readonly<{
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  fontSize: number;
}>;
export type StyleToggle = Exclude<keyof TextStyle, "fontSize">;
export type FormattingState = { -readonly [K in keyof TextStyle]: TextStyle[K] | null };
export type StyledCell = Readonly<{ text: string; style: TextStyle }>;
export type CellContent = string | StyledCell;

export const DEFAULT_TEXT_STYLE: TextStyle = Object.freeze({
  bold: false, italic: false, underline: false, strikethrough: false,
  fontSize: BASE_FONT_SIZE,
});

export function sameStyle(a: TextStyle, b: TextStyle): boolean {
  return a.bold === b.bold && a.italic === b.italic &&
    a.underline === b.underline && a.strikethrough === b.strikethrough &&
    a.fontSize === b.fontSize;
}

export function parseTextStyle(value: unknown): TextStyle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EditorError("잘못된 글자 서식입니다.");
  }
  const style = value as Record<string, unknown>;
  if (["bold", "italic", "underline", "strikethrough"].some((key) => typeof style[key] !== "boolean") ||
    typeof style.fontSize !== "number" || !Number.isInteger(style.fontSize) ||
    style.fontSize < MIN_FONT_SIZE || style.fontSize > MAX_FONT_SIZE) {
    throw new EditorError(`글자 크기는 ${MIN_FONT_SIZE}–${MAX_FONT_SIZE} 사이의 정수여야 하며, 서식 옵션은 참 또는 거짓이어야 합니다.`);
  }
  return Object.freeze({
    bold: style.bold as boolean, italic: style.italic as boolean,
    underline: style.underline as boolean, strikethrough: style.strikethrough as boolean,
    fontSize: style.fontSize,
  });
}

export function cellText(value: CellContent): string {
  return typeof value === "string" ? value : value.text;
}

export function cellStyle(value: CellContent): TextStyle {
  return typeof value === "string" ? DEFAULT_TEXT_STYLE : value.style;
}
