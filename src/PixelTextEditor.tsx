"use client";

import {
  ChangeEvent,
  ClipboardEvent,
  CompositionEvent,
  FormEvent,
  KeyboardEvent,
  PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { EditorModel, SelectionResizeEdge } from "@/lib/editor";
import { SparseDocument } from "@/lib/document";
import { segmentGraphemes } from "@/lib/graphemes";
import { exportJson, exportTxt, importJson } from "@/lib/io";
import {
  MAX_MINIMAP_ZOOM,
  MIN_MINIMAP_ZOOM,
  MinimapTransform,
  cellMetrics,
  clampMinimapZoom,
  drawEditorCanvas,
  drawMinimap,
  logicalToScreen,
  minimapToWorld,
  screenToCell,
} from "@/lib/renderer";
import { IndexedDocumentStorage } from "@/lib/storage";
import {
  Camera,
  EditorError,
  MAX_ZOOM,
  MIN_ZOOM,
  Position,
  Selection,
  isPointInSelection,
  selectionAutoPanVelocity,
  selectionFromCursorDrag,
} from "@/lib/types";

type SaveState = "loading" | "pending" | "saving" | "saved" | "error";

type DragState =
  | {
      kind: "pan";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      camera: Camera;
    }
  | {
      kind: "select";
      pointerId: number;
      anchor: Position;
      moved: boolean;
      clientX: number;
      clientY: number;
      autoPanned: boolean;
    }
  | {
      kind: "move";
      pointerId: number;
      start: Position;
      dx: number;
      dy: number;
      lastNonOverlappingOffset: Position;
    }
  | {
      kind: "resize";
      pointerId: number;
      edge: SelectionResizeEdge;
      original: Selection;
      boundary: number;
    };

const DEFAULT_CAMERA: Camera = { x: 0, y: 0, zoom: 1 };

function isHorizontalResizeEdge(
  edge: SelectionResizeEdge,
): edge is "left" | "right" {
  return edge === "left" || edge === "right";
}

function selectionBoundary(
  selection: Selection,
  edge: SelectionResizeEdge,
): number {
  if (edge === "left") return selection.x1;
  if (edge === "right") return selection.x2;
  if (edge === "top") return selection.y1;
  return selection.y2;
}

function setSelectionResizeCursor(
  canvas: HTMLCanvasElement,
  edge: SelectionResizeEdge | null,
): void {
  canvas.classList.toggle(
    "is-resizing-selection-horizontal",
    edge !== null && isHorizontalResizeEdge(edge),
  );
  canvas.classList.toggle(
    "is-resizing-selection-vertical",
    edge === "top" || edge === "bottom",
  );
}

function messageFromError(error: unknown): string {
  if (error instanceof EditorError || error instanceof Error) return error.message;
  return "요청한 작업을 완료하지 못했습니다.";
}

function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function todayStamp(): string {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export default function PixelTextEditor() {
  const [editor] = useState(() => new EditorModel());
  const [storage] = useState(() => new IndexedDocumentStorage());
  const [revision, setRevision] = useState(0);
  const [camera, setCameraState] = useState<Camera>({ ...DEFAULT_CAMERA });
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const [composition, setComposition] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [bookmarkName, setBookmarkName] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [selectionPreview, setSelectionPreview] = useState<{
    dx: number;
    dy: number;
  } | null>(null);
  const [selectionResizePreview, setSelectionResizePreview] =
    useState<Selection | null>(null);
  const [minimapZoom, setMinimapZoom] = useState(MIN_MINIMAP_ZOOM);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<Camera>({ ...DEFAULT_CAMERA });
  const dragRef = useRef<DragState | null>(null);
  const selectionAutoPanFrameRef = useRef<number | null>(null);
  const selectionAutoPanLastTimeRef = useRef<number | null>(null);
  const minimapDraggingRef = useRef(false);
  const minimapTransformRef = useRef<MinimapTransform | null>(null);
  const composingRef = useRef(false);
  const compositionRef = useRef("");
  const ignoreCompositionEndRef = useRef(false);
  const suppressInputRef = useRef("");
  const readyRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const saveRequestedRef = useRef(false);
  const metadataRevisionRef = useRef(0);
  const savedMetadataRevisionRef = useRef(0);
  const saveNowRef = useRef<() => Promise<void>>(async () => undefined);
  const frameRef = useRef<number | null>(null);
  const drawLatestRef = useRef<() => void>(() => undefined);

  const focusInput = useCallback(() => {
    window.setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), 0);
  }, []);

  const showError = useCallback((error: unknown) => {
    setNotice(messageFromError(error));
  }, []);

  const runAction = useCallback(
    (action: () => void) => {
      try {
        action();
      } catch (error) {
        showError(error);
      }
    },
    [showError],
  );

  const armSaveTimer = useCallback((delay = 500) => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveNowRef.current();
    }, delay);
  }, []);

  const scheduleSave = useCallback(() => {
    if (!readyRef.current) return;
    metadataRevisionRef.current += 1;
    setSaveState("pending");
    armSaveTimer();
  }, [armSaveTimer]);

  const saveNow = useCallback(async () => {
    if (!readyRef.current) return;
    if (saveInFlightRef.current) {
      saveRequestedRef.current = true;
      return;
    }
    const documentAtStart = editor.document;
    const metadataAtStart = metadataRevisionRef.current;
    if (
      !documentAtStart.isDirty &&
      metadataAtStart === savedMetadataRevisionRef.current
    ) {
      setSaveState("saved");
      return;
    }

    saveInFlightRef.current = true;
    saveRequestedRef.current = false;
    setSaveState("saving");
    const snapshot = storage.createSnapshot(
      documentAtStart,
      cameraRef.current,
      editor.bookmarks,
    );
    try {
      await storage.save(snapshot);
      documentAtStart.markSaved(snapshot.revisions);
      savedMetadataRevisionRef.current = Math.max(
        savedMetadataRevisionRef.current,
        metadataAtStart,
      );
      setSaveError("");
      const hasMore =
        editor.document.isDirty ||
        metadataRevisionRef.current > savedMetadataRevisionRef.current ||
        saveRequestedRef.current;
      setSaveState(hasMore ? "pending" : "saved");
      if (hasMore) armSaveTimer(200);
    } catch (error) {
      setSaveState("error");
      setSaveError(messageFromError(error));
    } finally {
      saveInFlightRef.current = false;
    }
  }, [armSaveTimer, editor, storage]);
  useEffect(() => {
    saveNowRef.current = saveNow;
  }, [saveNow]);

  const requestRender = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      drawLatestRef.current();
    });
  }, []);

  const setCamera = useCallback(
    (camera: Camera, persist = true) => {
      const next: Camera = {
        x: Number.isFinite(camera.x) ? camera.x : cameraRef.current.x,
        y: Number.isFinite(camera.y) ? camera.y : cameraRef.current.y,
        zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom)),
      };
      cameraRef.current = next;
      setCameraState(next);
      setRevision((value) => value + 1);
      requestRender();
      if (persist) scheduleSave();
    },
    [requestRender, scheduleSave],
  );

  useEffect(() => {
    const unsubscribe = editor.subscribe((change) => {
      setRevision((value) => value + 1);
      requestRender();
      if (change !== "transient") scheduleSave();
    });
    let active = true;
    void storage
      .load()
      .then((loaded) => {
        if (!active || !loaded) return;
        editor.loadState(loaded.document, loaded.bookmarks);
        cameraRef.current = loaded.camera;
        setCameraState(loaded.camera);
      })
      .catch((error) => {
        if (!active) return;
        setSaveState("error");
        setSaveError(messageFromError(error));
      })
      .finally(() => {
        if (!active) return;
        readyRef.current = true;
        savedMetadataRevisionRef.current = metadataRevisionRef.current;
        setReady(true);
        setSaveState((current) => (current === "error" ? current : "saved"));
        requestRender();
        focusInput();
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [editor, focusInput, requestRender, scheduleSave, storage]);

  useEffect(() => {
    const handlePageHide = () => void saveNowRef.current();
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      if (selectionAutoPanFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionAutoPanFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (searchOpen) window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [searchOpen]);

  const drawLatest = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const searchLength = segmentGraphemes(searchQuery).length;
    drawEditorCanvas(canvas, {
      document: editor.document,
      bookmarks: editor.bookmarks,
      camera: cameraRef.current,
      cursor: editor.cursor,
      overwriteMode: editor.overwriteMode,
      selection: editor.selection,
      composition,
      searchResults: editor.searchResults,
      activeSearchIndex: editor.searchIndex,
      searchLength,
      selectionPreview,
      selectionResizePreview,
    });
    const minimap = minimapRef.current;
    if (minimap) {
      const rect = canvas.getBoundingClientRect();
      minimapTransformRef.current = drawMinimap(
        minimap,
        editor.document,
        cameraRef.current,
        { width: rect.width, height: rect.height },
        minimapZoom,
      );
    }
    const input = textareaRef.current;
    if (input) {
      const rect = canvas.getBoundingClientRect();
      const point = logicalToScreen(editor.cursor, cameraRef.current, {
        width: rect.width,
        height: rect.height,
      });
      input.style.left = `${Math.min(rect.width - 2, Math.max(1, point.x))}px`;
      input.style.top = `${Math.min(rect.height - 2, Math.max(1, point.y))}px`;
    }
  }, [
    composition,
    editor,
    minimapZoom,
    searchQuery,
    selectionPreview,
    selectionResizePreview,
  ]);

  useEffect(() => {
    drawLatestRef.current = drawLatest;
  }, [drawLatest]);

  useEffect(() => {
    requestRender();
  }, [
    composition,
    minimapZoom,
    ready,
    requestRender,
    revision,
    searchQuery,
    selectionPreview,
    selectionResizePreview,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(requestRender);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [requestRender]);

  const cancelComposition = useCallback(() => {
    if (!composingRef.current) return;
    ignoreCompositionEndRef.current = true;
    composingRef.current = false;
    compositionRef.current = "";
    setComposition("");
    const input = textareaRef.current;
    if (input) {
      input.value = "";
      input.blur();
    }
    focusInput();
  }, [focusInput]);

  const finishCompositionBeforeCommand = useCallback(() => {
    if (!composingRef.current) return;
    const value = compositionRef.current;
    ignoreCompositionEndRef.current = true;
    composingRef.current = false;
    compositionRef.current = "";
    setComposition("");
    if (value) runAction(() => editor.insertText(value));
    const input = textareaRef.current;
    if (input) {
      input.value = "";
      input.blur();
    }
  }, [editor, runAction]);

  const centerOn = useCallback(
    (position: Position, horizontalOffset = 0) => {
      setCamera({
        ...cameraRef.current,
        x: position.x + horizontalOffset,
        y: position.y + 0.5,
      });
    },
    [setCamera],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const cursorCommands: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    if (event.key === "Insert") {
      event.preventDefault();
      if (event.repeat) return;
      finishCompositionBeforeCommand();
      runAction(() => editor.toggleOverwriteMode());
      focusInput();
      return;
    }
    if (event.key in cursorCommands) {
      event.preventDefault();
      finishCompositionBeforeCommand();
      const [dx, dy] = cursorCommands[event.key];
      runAction(() => editor.moveCursorOrSelection(dx, dy));
      focusInput();
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      finishCompositionBeforeCommand();
      runAction(() => editor.backspace());
      focusInput();
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      finishCompositionBeforeCommand();
      runAction(() => editor.deleteForward());
      focusInput();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      finishCompositionBeforeCommand();
      runAction(() => editor.enter());
      focusInput();
    }
  };

  useEffect(() => {
    const handleGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      const commandKey = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (commandKey && key === "z") {
        event.preventDefault();
        event.stopPropagation();
        finishCompositionBeforeCommand();
        runAction(() => (event.shiftKey ? editor.redo() : editor.undo()));
        focusInput();
        return;
      }
      if (commandKey && key === "f") {
        event.preventDefault();
        event.stopPropagation();
        finishCompositionBeforeCommand();
        setSearchOpen(true);
        setBookmarksOpen(false);
        setExportOpen(false);
        setHelpOpen(false);
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (composingRef.current) {
        cancelComposition();
        return;
      }
      editor.setSelection(null);
      setSearchOpen(false);
      setBookmarksOpen(false);
      setExportOpen(false);
      setHelpOpen(false);
      focusInput();
    };

    window.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown, true);
  }, [
    cancelComposition,
    editor,
    finishCompositionBeforeCommand,
    focusInput,
    runAction,
  ]);

  const handleBeforeInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const inputEvent = event.nativeEvent as InputEvent;
    if (composingRef.current || inputEvent.isComposing) return;
    if (inputEvent.inputType === "insertLineBreak") {
      event.preventDefault();
      runAction(() => editor.enter());
      return;
    }
    if (inputEvent.inputType === "deleteContentBackward") {
      event.preventDefault();
      runAction(() => editor.backspace());
      return;
    }
    if (inputEvent.inputType === "deleteContentForward") {
      event.preventDefault();
      runAction(() => editor.deleteForward());
    }
  };

  const handleInput = (event: FormEvent<HTMLTextAreaElement>) => {
    if (composingRef.current) return;
    const nativeEvent = event.nativeEvent as InputEvent;
    const value = event.currentTarget.value || nativeEvent.data || "";
    event.currentTarget.value = "";
    if (!value) return;
    if (suppressInputRef.current && value === suppressInputRef.current) {
      suppressInputRef.current = "";
      return;
    }
    suppressInputRef.current = "";
    runAction(() => editor.insertText(value));
  };

  const handleCompositionStart = () => {
    composingRef.current = true;
    ignoreCompositionEndRef.current = false;
    compositionRef.current = "";
    setComposition("");
  };

  const handleCompositionUpdate = (event: CompositionEvent<HTMLTextAreaElement>) => {
    compositionRef.current = event.data;
    setComposition(event.data);
  };

  const handleCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    if (ignoreCompositionEndRef.current) {
      ignoreCompositionEndRef.current = false;
      return;
    }
    const value = event.data || compositionRef.current;
    composingRef.current = false;
    compositionRef.current = "";
    setComposition("");
    suppressInputRef.current = value;
    if (value) runAction(() => editor.insertText(value));
    if (textareaRef.current) textareaRef.current.value = "";
  };

  const handleCopy = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!editor.selection) return;
    event.preventDefault();
    runAction(() => {
      event.clipboardData.setData("text/plain", editor.copySelection());
    });
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    finishCompositionBeforeCommand();
    const text = event.clipboardData.getData("text/plain");
    runAction(() => editor.insertText(text));
    focusInput();
  };

  const pointerCell = (
    event: PointerEvent<HTMLCanvasElement>,
  ): Position | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const position = screenToCell(
      event.clientX - rect.left,
      event.clientY - rect.top,
      cameraRef.current,
      { width: rect.width, height: rect.height },
    );
    if (!Number.isSafeInteger(position.x) || !Number.isSafeInteger(position.y)) {
      showError(new EditorError("이 위치에는 커서를 놓을 수 없습니다."));
      return null;
    }
    return position;
  };

  const resizeEdgeAtPointer = (
    event: PointerEvent<HTMLCanvasElement>,
  ): SelectionResizeEdge | null => {
    const canvas = canvasRef.current;
    const selection = editor.selection;
    if (!canvas || !selection) return null;
    const rect = canvas.getBoundingClientRect();
    const viewport = { width: rect.width, height: rect.height };
    const topLeft = logicalToScreen(
      { x: selection.x1, y: selection.y1 },
      cameraRef.current,
      viewport,
    );
    const bottomRight = logicalToScreen(
      { x: selection.x2, y: selection.y2 },
      cameraRef.current,
      viewport,
    );
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const metrics = cellMetrics(cameraRef.current);
    const hitSlop = Math.min(
      9,
      Math.max(5, Math.min(metrics.width, metrics.height) * 0.25),
    );
    const minX = Math.min(topLeft.x, bottomRight.x);
    const maxX = Math.max(topLeft.x, bottomRight.x);
    const minY = Math.min(topLeft.y, bottomRight.y);
    const maxY = Math.max(topLeft.y, bottomRight.y);
    const candidates: Array<{
      edge: SelectionResizeEdge;
      distance: number;
    }> = [];
    if (pointerY >= minY - hitSlop && pointerY <= maxY + hitSlop) {
      candidates.push(
        { edge: "left", distance: Math.abs(pointerX - topLeft.x) },
        { edge: "right", distance: Math.abs(pointerX - bottomRight.x) },
      );
    }
    if (pointerX >= minX - hitSlop && pointerX <= maxX + hitSlop) {
      candidates.push(
        { edge: "top", distance: Math.abs(pointerY - topLeft.y) },
        { edge: "bottom", distance: Math.abs(pointerY - bottomRight.y) },
      );
    }
    const nearest = candidates
      .filter((candidate) => candidate.distance <= hitSlop)
      .sort((a, b) => a.distance - b.distance)[0];
    return nearest?.edge ?? null;
  };

  const pointerBoundaryX = (
    event: PointerEvent<HTMLCanvasElement>,
  ): number | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const metrics = cellMetrics(cameraRef.current);
    const logicalX =
      cameraRef.current.x +
      (event.clientX - rect.left - rect.width / 2) / metrics.width;
    const boundaryX = Math.round(logicalX);
    if (!Number.isSafeInteger(boundaryX)) {
      showError(new EditorError("이 위치까지 선택 영역을 조절할 수 없습니다."));
      return null;
    }
    return boundaryX;
  };

  const pointerBoundaryY = (
    event: PointerEvent<HTMLCanvasElement>,
  ): number | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const metrics = cellMetrics(cameraRef.current);
    const logicalY =
      cameraRef.current.y +
      (event.clientY - rect.top - rect.height / 2) / metrics.height;
    const boundaryY = Math.round(logicalY);
    if (!Number.isSafeInteger(boundaryY)) {
      showError(new EditorError("이 위치까지 선택 영역을 조절할 수 없습니다."));
      return null;
    }
    return boundaryY;
  };

  const stopSelectionAutoPan = () => {
    if (selectionAutoPanFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionAutoPanFrameRef.current);
      selectionAutoPanFrameRef.current = null;
    }
    selectionAutoPanLastTimeRef.current = null;
  };

  function selectionAutoPanStep(timestamp: number) {
    selectionAutoPanFrameRef.current = null;
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (!canvas || drag?.kind !== "select") {
      selectionAutoPanLastTimeRef.current = null;
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const velocityX = selectionAutoPanVelocity(
      drag.clientX - rect.left,
      rect.width,
    );
    const velocityY = selectionAutoPanVelocity(
      drag.clientY - rect.top,
      rect.height,
    );
    if (velocityX === 0 && velocityY === 0) {
      selectionAutoPanLastTimeRef.current = null;
      return;
    }

    const previousTime = selectionAutoPanLastTimeRef.current;
    const elapsedSeconds = Math.min(
      0.05,
      previousTime === null ? 1 / 60 : (timestamp - previousTime) / 1000,
    );
    selectionAutoPanLastTimeRef.current = timestamp;
    const current = cameraRef.current;
    const metrics = cellMetrics(current);
    setCamera(
      {
        ...current,
        x: current.x + (velocityX * elapsedSeconds) / metrics.width,
        y: current.y + (velocityY * elapsedSeconds) / metrics.height,
      },
      false,
    );
    drag.autoPanned = true;

    const focus = screenToCell(
      drag.clientX - rect.left,
      drag.clientY - rect.top,
      cameraRef.current,
      { width: rect.width, height: rect.height },
    );
    if (Number.isSafeInteger(focus.x) && Number.isSafeInteger(focus.y)) {
      drag.moved =
        drag.moved || focus.x !== drag.anchor.x || focus.y !== drag.anchor.y;
      if (drag.moved) {
        editor.setSelection(selectionFromCursorDrag(drag.anchor, focus));
        editor.setCursor(focus, false);
      }
    }

    selectionAutoPanFrameRef.current = window.requestAnimationFrame(
      selectionAutoPanStep,
    );
  }

  const ensureSelectionAutoPan = () => {
    if (selectionAutoPanFrameRef.current !== null) return;
    selectionAutoPanFrameRef.current = window.requestAnimationFrame(
      selectionAutoPanStep,
    );
  };

  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button === 2) {
      event.preventDefault();
      finishCompositionBeforeCommand();
      focusInput();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        kind: "pan",
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        camera: { ...cameraRef.current },
      };
      event.currentTarget.classList.add("is-panning");
      return;
    }
    if (event.button !== 0) return;
    finishCompositionBeforeCommand();
    focusInput();
    const resizeEdge = resizeEdgeAtPointer(event);
    if (resizeEdge && editor.selection) {
      const original = { ...editor.selection };
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        kind: "resize",
        pointerId: event.pointerId,
        edge: resizeEdge,
        original,
        boundary: selectionBoundary(original, resizeEdge),
      };
      setSelectionResizePreview(original);
      setSelectionResizeCursor(event.currentTarget, resizeEdge);
      return;
    }
    const cell = pointerCell(event);
    if (!cell) return;
    event.currentTarget.setPointerCapture(event.pointerId);

    if (isPointInSelection(cell, editor.selection)) {
      dragRef.current = {
        kind: "move",
        pointerId: event.pointerId,
        start: cell,
        dx: 0,
        dy: 0,
        lastNonOverlappingOffset: { x: 0, y: 0 },
      };
      setSelectionPreview({ dx: 0, dy: 0 });
      return;
    }
    dragRef.current = {
      kind: "select",
      pointerId: event.pointerId,
      anchor: cell,
      moved: false,
      clientX: event.clientX,
      clientY: event.clientY,
      autoPanned: false,
    };
    editor.setCursor(cell);
  };

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      setSelectionResizeCursor(event.currentTarget, resizeEdgeAtPointer(event));
      return;
    }
    if (drag.pointerId !== event.pointerId) return;
    if (drag.kind === "pan") {
      const metrics = cellMetrics(drag.camera);
      setCamera({
        ...drag.camera,
        x: drag.camera.x - (event.clientX - drag.startClientX) / metrics.width,
        y: drag.camera.y - (event.clientY - drag.startClientY) / metrics.height,
      });
      return;
    }
    if (drag.kind === "resize") {
      const pointerBoundary = isHorizontalResizeEdge(drag.edge)
        ? pointerBoundaryX(event)
        : pointerBoundaryY(event);
      if (pointerBoundary === null) return;
      if (drag.edge === "left") {
        drag.boundary = Math.min(pointerBoundary, drag.original.x2 - 1);
      } else if (drag.edge === "right") {
        drag.boundary = Math.max(pointerBoundary, drag.original.x1 + 1);
      } else if (drag.edge === "top") {
        drag.boundary = Math.min(pointerBoundary, drag.original.y2 - 1);
      } else {
        drag.boundary = Math.max(pointerBoundary, drag.original.y1 + 1);
      }
      const preview = { ...drag.original };
      if (drag.edge === "left") preview.x1 = drag.boundary;
      else if (drag.edge === "right") preview.x2 = drag.boundary;
      else if (drag.edge === "top") preview.y1 = drag.boundary;
      else preview.y2 = drag.boundary;
      setSelectionResizePreview(preview);
      return;
    }
    const cell = pointerCell(event);
    if (!cell) return;
    if (drag.kind === "select") {
      drag.clientX = event.clientX;
      drag.clientY = event.clientY;
      ensureSelectionAutoPan();
      drag.moved = drag.moved || cell.x !== drag.anchor.x || cell.y !== drag.anchor.y;
      if (!drag.moved) return;
      editor.setSelection(selectionFromCursorDrag(drag.anchor, cell));
      editor.setCursor(cell, false);
      return;
    }
    drag.dx = cell.x - drag.start.x;
    drag.dy = cell.y - drag.start.y;
    if (!editor.selectionMoveTargetOverlapsText(drag.dx, drag.dy)) {
      drag.lastNonOverlappingOffset = { x: drag.dx, y: drag.dy };
    }
    setSelectionPreview({ dx: drag.dx, dy: drag.dy });
  };

  const handlePointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    stopSelectionAutoPan();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.currentTarget.classList.remove("is-panning");
    setSelectionResizeCursor(event.currentTarget, null);
    if (
      drag.kind === "resize" &&
      drag.boundary !== selectionBoundary(drag.original, drag.edge)
    ) {
      runAction(() => {
        if (isHorizontalResizeEdge(drag.edge)) {
          editor.resizeSelectionHorizontal(drag.edge, drag.boundary);
        } else {
          editor.resizeSelectionVertical(drag.edge, drag.boundary);
        }
      });
    } else if (drag.kind === "move" && (drag.dx !== 0 || drag.dy !== 0)) {
      runAction(() => editor.moveSelection(drag.dx, drag.dy, {
        lastNonOverlappingOffset: drag.lastNonOverlappingOffset,
      }));
    } else if (drag.kind === "move") {
      editor.setCursor(drag.start);
    } else if (drag.kind === "select" && !drag.moved) {
      editor.setSelection(null);
      editor.setCursor(drag.anchor);
    }
    if (drag.kind === "select" && drag.autoPanned) scheduleSave();
    dragRef.current = null;
    setSelectionPreview(null);
    setSelectionResizePreview(null);
    focusInput();
  };

  const handlePointerLeave = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) {
      setSelectionResizeCursor(event.currentTarget, null);
    }
  };

  const handleWheel = useCallback((event: globalThis.WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const current = cameraRef.current;
    const oldMetrics = cellMetrics(current);
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const logicalX = current.x + (mouseX - rect.width / 2) / oldMetrics.width;
    const logicalY = current.y + (mouseY - rect.height / 2) / oldMetrics.height;
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, current.zoom * Math.exp(-event.deltaY * 0.002)),
    );
    const nextMetrics = cellMetrics({ ...current, zoom });
    setCamera({
      x: logicalX - (mouseX - rect.width / 2) / nextMetrics.width,
      y: logicalY - (mouseY - rect.height / 2) / nextMetrics.height,
      zoom,
    });
  }, [setCamera]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener("wheel", handleWheel, {
      passive: false,
      capture: true,
    });
    return () => {
      canvas.removeEventListener("wheel", handleWheel, { capture: true });
    };
  }, [handleWheel]);

  const handleMinimapWheel = useCallback((event: globalThis.WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    setMinimapZoom((current) => clampMinimapZoom(
      current * Math.exp(-event.deltaY * 0.002),
    ));
  }, []);

  useEffect(() => {
    const minimap = minimapRef.current;
    if (!minimap) return;
    minimap.addEventListener("wheel", handleMinimapWheel, {
      passive: false,
      capture: true,
    });
    return () => {
      minimap.removeEventListener("wheel", handleMinimapWheel, { capture: true });
    };
  }, [handleMinimapWheel]);

  const updateSearch = (query: string) => {
    setSearchQuery(query);
    runAction(() => editor.search(query));
  };

  const navigateSearch = (direction: 1 | -1) => {
    const result = editor.navigateSearch(direction);
    if (result) centerOn(result, segmentGraphemes(searchQuery).length / 2);
  };

  const addBookmark = () => {
    const defaultName = `지점 ${editor.bookmarks.length + 1}`;
    runAction(() => editor.addBookmark(bookmarkName || defaultName));
    setBookmarkName("");
    focusInput();
  };

  const visitBookmark = (position: Position) => {
    finishCompositionBeforeCommand();
    editor.setCursor(position);
    centerOn(position);
    setBookmarksOpen(false);
    focusInput();
  };

  const handleNewDocument = () => {
    finishCompositionBeforeCommand();
    const hasDocumentData =
      editor.document.cellCount > 0 || editor.bookmarks.length > 0;
    if (
      hasDocumentData &&
      !window.confirm(
        "현재 문서의 내용과 책갈피를 지우고 새 문서를 만드시겠습니까?",
      )
    ) {
      focusInput();
      return;
    }

    runAction(() => editor.replaceDocument(new SparseDocument(), []));
    setCamera({ ...DEFAULT_CAMERA });
    setSearchQuery("");
    setMinimapZoom(MIN_MINIMAP_ZOOM);
    setExportOpen(false);
    setNotice("새 문서를 만들었습니다.");
    focusInput();
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const imported = importJson(await file.text());
      editor.replaceDocument(imported.document, imported.bookmarks);
      setCamera(imported.camera);
      setNotice("문서를 가져왔습니다.");
      setExportOpen(false);
    } catch (error) {
      showError(error);
    }
    focusInput();
  };

  const handleJsonExport = () => {
    runAction(() => {
      downloadText(
        `pixeltext-${todayStamp()}.json`,
        exportJson(editor.document, editor.bookmarks, cameraRef.current),
        "application/json;charset=utf-8",
      );
      setExportOpen(false);
    });
    focusInput();
  };

  const handleTxtExport = () => {
    runAction(() => {
      try {
        downloadText(
          `pixeltext-${todayStamp()}.txt`,
          exportTxt(editor.document),
          "text/plain;charset=utf-8",
        );
        setExportOpen(false);
      } catch (error) {
        throw new EditorError(`${messageFromError(error)} JSON 내보내기를 사용하세요.`);
      }
    });
    focusInput();
  };

  const adjustZoom = (factor: number) => {
    setCamera({
      ...cameraRef.current,
      zoom: cameraRef.current.zoom * factor,
    });
    focusInput();
  };

  const handleMinimapPointer = (event: PointerEvent<HTMLCanvasElement>) => {
    const transform = minimapTransformRef.current;
    if (!transform) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const world = minimapToWorld(
      event.clientX - rect.left,
      event.clientY - rect.top,
      transform,
    );
    setCamera({ ...cameraRef.current, x: world.x, y: world.y });
  };

  const selectionSize = editor.selection
    ? `${editor.selection.x2 - editor.selection.x1}×${editor.selection.y2 - editor.selection.y1}`
    : "";
  const saveLabel: Record<SaveState, string> = {
    loading: "불러오는 중",
    pending: "저장 대기",
    saving: "저장 중",
    saved: "저장됨",
    error: "저장 실패",
  };
  return (
    <main className="pixeltext-app">
      <header className="app-header">
        <div className="brand" aria-label="PixelText">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>PixelText</span>
        </div>

        <nav className="toolbar" aria-label="편집 도구">
          <div className="tool-group history-tools">
            <button
              className="icon-button"
              type="button"
              aria-label="실행 취소"
              title="실행 취소 (Ctrl+Z)"
              disabled={!editor.canUndo}
              onClick={() => {
                runAction(() => editor.undo());
                focusInput();
              }}
            >
              <span aria-hidden="true">↶</span>
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="다시 실행"
              title="다시 실행 (Ctrl+Shift+Z)"
              disabled={!editor.canRedo}
              onClick={() => {
                runAction(() => editor.redo());
                focusInput();
              }}
            >
              <span aria-hidden="true">↷</span>
            </button>
          </div>

          <div className="toolbar-divider" />
          <button
            className={`text-button ${searchOpen ? "is-active" : ""}`}
            type="button"
            aria-label="찾기"
            aria-expanded={searchOpen}
            aria-controls="search-panel"
            onClick={() => {
              setSearchOpen((value) => !value);
              setBookmarksOpen(false);
              setExportOpen(false);
              setHelpOpen(false);
            }}
          >
            <span className="tool-symbol" aria-hidden="true">⌕</span>
            <span className="tool-label">찾기</span>
          </button>
          <button
            className={`text-button ${bookmarksOpen ? "is-active" : ""}`}
            type="button"
            aria-label="책갈피"
            aria-expanded={bookmarksOpen}
            aria-controls="bookmarks-panel"
            onClick={() => {
              setBookmarksOpen((value) => !value);
              setSearchOpen(false);
              setExportOpen(false);
              setHelpOpen(false);
            }}
          >
            <span className="tool-symbol bookmark-symbol" aria-hidden="true">◇</span>
            <span className="tool-label">책갈피</span>
          </button>
          <div className="toolbar-divider compact-divider" />
          <button
            className={`text-button ${exportOpen ? "is-active" : ""}`}
            type="button"
            aria-label="파일"
            aria-expanded={exportOpen}
            aria-controls="file-panel"
            onClick={() => {
              setExportOpen((value) => !value);
              setSearchOpen(false);
              setBookmarksOpen(false);
              setHelpOpen(false);
            }}
          >
            <span className="tool-symbol" aria-hidden="true">⇅</span>
            <span className="tool-label">파일</span>
          </button>
          <button
            className={`icon-button help-button ${helpOpen ? "is-active" : ""}`}
            type="button"
            aria-label="도움말"
            aria-expanded={helpOpen}
            aria-controls="help-panel"
            onClick={() => {
              setHelpOpen((value) => !value);
              setSearchOpen(false);
              setBookmarksOpen(false);
              setExportOpen(false);
            }}
          >
            <span aria-hidden="true">?</span>
          </button>
        </nav>
      </header>

      <section className="canvas-stage" aria-label="무한 문자 캔버스">
        <canvas
          ref={canvasRef}
          className="editor-canvas"
          aria-label="무한 문자 캔버스. 클릭하여 커서를 놓고 입력하세요."
          aria-describedby="canvas-instructions"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onContextMenu={(event) => event.preventDefault()}
        />
        <p id="canvas-instructions" className="sr-only">
          방향키로 커서를 이동합니다. 선택 영역이 있으면 방향키로 영역 안의
          문자를 한 칸씩 이동합니다. Insert 키로 삽입과 덮어쓰기 모드를
          전환합니다. 마우스 끌기로 사각형을 선택하며, 선택 중 화면 가장자리로
          끌면 캔버스가 자동 이동합니다. 선택의 상하좌우 경계를 끌면 크기를
          조절하며, 왼쪽이나 오른쪽 경계를 줄일 때 글 시작 위치에 맞춰 자동
          줄바꿈합니다. 마우스 오른쪽 버튼을 누른 채 끌면 화면을 이동하고
          Ctrl과 휠로 확대합니다.
        </p>
        <textarea
          ref={textareaRef}
          className="ime-input"
          aria-label={`캔버스 문자 입력, ${editor.overwriteMode ? "덮어쓰기" : "삽입"} 모드`}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={handleKeyDown}
          onBeforeInput={handleBeforeInput}
          onInput={handleInput}
          onCompositionStart={handleCompositionStart}
          onCompositionUpdate={handleCompositionUpdate}
          onCompositionEnd={handleCompositionEnd}
          onCopy={handleCopy}
          onPaste={handlePaste}
        />

        {!ready && (
          <div className="loading-state" role="status">
            <span className="loading-dot" />
            캔버스를 준비하고 있습니다
          </div>
        )}

        {searchOpen && (
          <div id="search-panel" className="floating-panel search-panel">
            <label className="search-field">
              <span aria-hidden="true">⌕</span>
              <input
                ref={searchInputRef}
                value={searchQuery}
                aria-label="전체 캔버스에서 찾기"
                placeholder="전체 캔버스에서 찾기"
                onChange={(event) => updateSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    navigateSearch(event.shiftKey ? -1 : 1);
                  }
                }}
              />
            </label>
            <span className="result-count" aria-live="polite">
              {editor.searchResults.length === 0
                ? "0 / 0"
                : `${editor.searchIndex + 1} / ${editor.searchResults.length}`}
            </span>
            <button
              className="panel-icon-button"
              type="button"
              aria-label="이전 결과"
              disabled={editor.searchResults.length === 0}
              onClick={() => navigateSearch(-1)}
            >
              ↑
            </button>
            <button
              className="panel-icon-button"
              type="button"
              aria-label="다음 결과"
              disabled={editor.searchResults.length === 0}
              onClick={() => navigateSearch(1)}
            >
              ↓
            </button>
            <button
              className="panel-icon-button"
              type="button"
              aria-label="찾기 닫기"
              onClick={() => {
                setSearchOpen(false);
                focusInput();
              }}
            >
              ×
            </button>
          </div>
        )}

        {bookmarksOpen && (
          <aside
            id="bookmarks-panel"
            className="floating-panel bookmark-panel"
            aria-label="책갈피"
          >
            <div className="panel-heading">
              <div>
                <p className="eyebrow">BOOKMARKS</p>
                <h2>책갈피</h2>
              </div>
              <button
                className="panel-icon-button"
                type="button"
                aria-label="책갈피 닫기"
                onClick={() => {
                  setBookmarksOpen(false);
                  focusInput();
                }}
              >
                ×
              </button>
            </div>
            <div className="bookmark-form">
              <input
                value={bookmarkName}
                placeholder={`지점 ${editor.bookmarks.length + 1}`}
                aria-label="새 책갈피 이름"
                onChange={(event) => setBookmarkName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") addBookmark();
                }}
              />
              <button type="button" onClick={addBookmark}>현재 위치 저장</button>
            </div>
            <div className="bookmark-list">
              {editor.bookmarks.length === 0 ? (
                <p className="panel-empty">저장한 위치가 없습니다.</p>
              ) : (
                editor.bookmarks.map((bookmark) => (
                  <div className="bookmark-row" key={bookmark.id}>
                    <button
                      className="bookmark-target"
                      type="button"
                      onClick={() => visitBookmark(bookmark)}
                    >
                      <span>{bookmark.name}</span>
                      <small>{bookmark.x}, {bookmark.y}</small>
                    </button>
                    <button
                      className="remove-button"
                      type="button"
                      aria-label={`${bookmark.name} 삭제`}
                      onClick={() => editor.removeBookmark(bookmark.id)}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          </aside>
        )}

        {exportOpen && (
          <div
            id="file-panel"
            className="floating-panel file-panel"
            aria-label="파일 메뉴"
          >
            <button
              type="button"
              className="file-action"
              onClick={handleNewDocument}
            >
              <span>새로 만들기</span>
              <small>빈 캔버스에서 새 문서 시작</small>
            </button>
            <div className="panel-rule" />
            <p className="panel-section-label">가져오기</p>
            <button
              type="button"
              className="file-action"
              onClick={() => importInputRef.current?.click()}
            >
              <span>JSON 문서 열기</span>
              <small>현재 문서를 검증 후 교체</small>
            </button>
            <div className="panel-rule" />
            <p className="panel-section-label">내보내기</p>
            <button type="button" className="file-action" onClick={handleJsonExport}>
              <span>JSON으로 저장</span>
              <small>좌표와 책갈피를 모두 보존</small>
            </button>
            <button type="button" className="file-action" onClick={handleTxtExport}>
              <span>TXT로 저장</span>
              <small>사용 영역을 일반 텍스트로 변환</small>
            </button>
          </div>
        )}

        {helpOpen && (
          <div id="help-panel" className="floating-panel help-panel">
            <div className="panel-heading compact-heading">
              <div>
                <p className="eyebrow">QUICK GUIDE</p>
                <h2>빠른 사용법</h2>
              </div>
              <button
                className="panel-icon-button"
                type="button"
                aria-label="도움말 닫기"
                onClick={() => {
                  setHelpOpen(false);
                  focusInput();
                }}
              >
                ×
              </button>
            </div>
            <dl className="shortcut-list">
              <div><dt>화면 이동</dt><dd><kbd>우클릭</kbd> + 끌기</dd></div>
              <div><dt>확대 · 축소</dt><dd><kbd>Ctrl</kbd> + 휠</dd></div>
              <div><dt>미니맵 확대 · 축소</dt><dd>미니맵 위 <kbd>Ctrl</kbd> + 휠</dd></div>
              <div><dt>사각형 선택</dt><dd>캔버스 끌기 · 가장자리 자동 이동</dd></div>
              <div><dt>선택 크기</dt><dd>선택 영역의 상하좌우 경계 끌기</dd></div>
              <div><dt>선택 이동</dt><dd>삽입 모드: 방향키 방향 · 끌기는 마지막 비겹침 위치 기준</dd></div>
              <div><dt>입력 모드</dt><dd><kbd>Insert</kbd> 삽입 · 덮어쓰기 전환</dd></div>
              <div><dt>실행 취소</dt><dd><kbd>Ctrl</kbd> + <kbd>Z</kbd></dd></div>
              <div><dt>다시 실행</dt><dd><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd></dd></div>
            </dl>
          </div>
        )}

        <div className="zoom-control" aria-label="확대 및 축소">
          <button type="button" aria-label="축소" onClick={() => adjustZoom(0.8)}>−</button>
          <span>{Math.round(camera.zoom * 100)}%</span>
          <button type="button" aria-label="확대" onClick={() => adjustZoom(1.25)}>+</button>
        </div>

        <div className="minimap-shell">
          <span className="minimap-label">
            MAP {minimapZoom > MIN_MINIMAP_ZOOM && `${Math.round(minimapZoom * 100)}%`}
          </span>
          <canvas
            ref={minimapRef}
            className="minimap"
            aria-label={`미니맵. 클릭하거나 끌어 이동합니다. Ctrl과 휠로 확대하거나 축소합니다. 현재 ${Math.round(minimapZoom * 100)}%, 최대 ${MAX_MINIMAP_ZOOM * 100}%`}
            onPointerDown={(event) => {
              minimapDraggingRef.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              handleMinimapPointer(event);
            }}
            onPointerMove={(event) => {
              if (minimapDraggingRef.current) handleMinimapPointer(event);
            }}
            onPointerUp={(event) => {
              minimapDraggingRef.current = false;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              focusInput();
            }}
          />
        </div>

        {notice && (
          <div className="notice" role="alert">
            <span aria-hidden="true">!</span>
            {notice}
          </div>
        )}
      </section>

      <footer className="status-bar">
        <div className="coordinate-status">
          <span><b>x</b> {editor.cursor.x.toLocaleString("ko-KR")}</span>
          <span><b>y</b> {editor.cursor.y.toLocaleString("ko-KR")}</span>
          <span className="desktop-status"><b>확대</b> {Math.round(camera.zoom * 100)}%</span>
          <span><b>문자</b> {editor.document.cellCount.toLocaleString("ko-KR")}</span>
          <span><b>모드</b> {editor.overwriteMode ? "덮어쓰기" : "삽입"}</span>
          {selectionSize && <span><b>선택</b> {selectionSize}</span>}
        </div>
        <div className={`save-status save-${saveState}`} title={saveError}>
          <span className="save-dot" />
          <span>{saveLabel[saveState]}</span>
          {saveState === "error" && (
            <button type="button" onClick={() => void saveNow()}>재시도</button>
          )}
        </div>
      </footer>

      <input
        ref={importInputRef}
        className="sr-only"
        type="file"
        accept="application/json,.json"
        onChange={(event) => void handleImport(event)}
      />
    </main>
  );
}
