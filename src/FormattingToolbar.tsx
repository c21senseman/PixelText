import { useState, type PointerEvent } from "react";
import { BASE_FONT_SIZE, FONT_SIZES, MAX_FONT_SIZE, MIN_FONT_SIZE, type FormattingState, type StyleToggle, type TextStyle } from "@/lib/formatting";

const TOGGLES: Array<{ key: StyleToggle; label: string; symbol: string; shortcut?: string }> = [
  { key: "bold", label: "굵게", symbol: "B", shortcut: "Ctrl/Cmd+B" },
  { key: "italic", label: "기울임", symbol: "I", shortcut: "Ctrl/Cmd+I" },
  { key: "underline", label: "밑줄", symbol: "U", shortcut: "Ctrl/Cmd+U" },
  { key: "strikethrough", label: "취소선", symbol: "S" },
];

export function FormattingToolbar({ state, disabled, onToggle, onStyle, beforeCommand, focusEditor }: {
  state: FormattingState;
  disabled: boolean;
  onToggle: (key: StyleToggle) => void;
  onStyle: (style: Partial<TextStyle>) => void;
  beforeCommand: () => void;
  focusEditor: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const preserveInput = (event: PointerEvent<HTMLButtonElement>) => {
    if (document.activeElement instanceof HTMLTextAreaElement) event.preventDefault();
    beforeCommand();
  };
  const applySize = () => {
    if (draft === null) return;
    const size = Number(draft);
    if (!draft.trim() || !Number.isInteger(size) || size < MIN_FONT_SIZE || size > MAX_FONT_SIZE) {
      setInvalid(true);
      return;
    }
    beforeCommand();
    onStyle({ fontSize: size });
    setDraft(null);
    setInvalid(false);
  };
  const stepSize = (direction: 1 | -1) => {
    const current = state.fontSize ?? BASE_FONT_SIZE;
    const next = direction > 0 ? FONT_SIZES.find((size) => size > current) ?? MAX_FONT_SIZE
      : [...FONT_SIZES].reverse().find((size) => size < current) ?? MIN_FONT_SIZE;
    beforeCommand();
    onStyle({ fontSize: next });
    setDraft(null);
    setInvalid(false);
    focusEditor();
  };

  return (
    <div className="formatting-tools" role="group" aria-label="글자 서식">
      <div className="tool-group">
        {TOGGLES.map(({ key, label, symbol, shortcut }) => (
          <button key={key} type="button" disabled={disabled}
            className={`icon-button format-button format-${key} ${state[key] === true ? "is-active" : ""}`}
            aria-label={label} aria-pressed={state[key] === null ? "mixed" : state[key]}
            title={`${label}${shortcut ? ` (${shortcut})` : ""}${state[key] === null ? " · 서식 혼합" : ""}`}
            onPointerDown={preserveInput}
            onClick={() => { beforeCommand(); onToggle(key); focusEditor(); }}>
            <span aria-hidden="true">{symbol}</span>
          </button>
        ))}
      </div>
      <div className="font-size-control" role="group" aria-label="글자 크기 조절">
        <button className="icon-button size-step" type="button" aria-label="글자 크기 줄이기" title="글자 크기 줄이기"
          disabled={disabled || state.fontSize === MIN_FONT_SIZE} onPointerDown={preserveInput} onClick={() => stepSize(-1)}>
          <span aria-hidden="true">A−</span>
        </button>
        <input type="text" inputMode="numeric" list="font-size-options" aria-label="글자 크기"
          aria-invalid={invalid} aria-describedby={invalid ? "font-size-error" : undefined}
          disabled={disabled} className="font-size-input" value={draft ?? state.fontSize ?? ""}
          placeholder="혼합" title={`글자 크기 (${MIN_FONT_SIZE}–${MAX_FONT_SIZE})`}
          onPointerDown={beforeCommand}
          onChange={(event) => { setDraft(event.target.value); setInvalid(false); }}
          onBlur={applySize}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault(); applySize();
              const size = Number(draft ?? state.fontSize);
              if (Number.isInteger(size) && size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE) focusEditor();
            } else if (event.key === "Escape") {
              event.preventDefault(); event.stopPropagation(); setDraft(null); setInvalid(false); focusEditor();
            }
          }} />
        <datalist id="font-size-options">{FONT_SIZES.map((size) => <option value={size} key={size} />)}</datalist>
        <button className="icon-button size-step" type="button" aria-label="글자 크기 키우기" title="글자 크기 키우기"
          disabled={disabled || state.fontSize === MAX_FONT_SIZE} onPointerDown={preserveInput} onClick={() => stepSize(1)}>
          <span aria-hidden="true">A+</span>
        </button>
        {invalid && <span id="font-size-error" className="font-size-error" role="alert">{MIN_FONT_SIZE}–{MAX_FONT_SIZE} 사이의 정수를 입력하세요.</span>}
      </div>
    </div>
  );
}
