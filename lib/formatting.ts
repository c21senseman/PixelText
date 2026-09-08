import { EditorError } from "./types";
import { graphemeWidth } from "./graphemes";

export const BASE_FONT_SIZE = 1;
export const BASE_FONT_PIXELS = 19;
export const MIN_FONT_SIZE = BASE_FONT_SIZE;
export const FONT_SIZES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16];

export function nextFontSize(current: number, direction: 1 | -1): number {
  return Math.max(MIN_FONT_SIZE, current + direction);
}

export function textWidthInCells(text: string, style: TextStyle = DEFAULT_TEXT_STYLE): number {
  return text === " " ? 1 : Math.ceil(graphemeWidth(text) * (style.fontSize / BASE_FONT_SIZE));
}

export function textHeightInCells(style: TextStyle): number {
  return Math.ceil(style.fontSize / BASE_FONT_SIZE);
}

export function contentWidth(value: CellContent): number {
  return textWidthInCells(cellText(value), cellStyle(value));
}

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
    typeof style.fontSize !== "number" || !Number.isSafeInteger(style.fontSize) ||
    style.fontSize < MIN_FONT_SIZE) {
    throw new EditorError(`글자 크기는 ${MIN_FONT_SIZE} 이상의 안전한 정수여야 하며, 서식 옵션은 참 또는 거짓이어야 합니다.`);
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

// Versions 1/2 stored CSS pixel sizes rather than integer grid multipliers.
export function parseLegacyTextStyle(value: unknown): TextStyle {
  const raw = value as Partial<TextStyle> | null;
  if (!raw || typeof raw.fontSize !== "number" || !Number.isSafeInteger(raw.fontSize) || raw.fontSize < 8 || raw.fontSize > 96) {
    throw new EditorError("잘못된 이전 버전 글자 크기입니다.");
  }
  return parseTextStyle({ ...raw, fontSize: Math.max(1, Math.round(raw.fontSize / BASE_FONT_PIXELS)) });
}
