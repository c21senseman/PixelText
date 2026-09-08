import assert from "node:assert/strict";
import test from "node:test";
import { SparseDocument } from "../lib/document";
import { DEFAULT_TEXT_STYLE } from "../lib/formatting";
import { drawMinimap } from "../lib/renderer";

test("minimap skips unchanged frames and redraws after every visual dependency changes", () => {
  let clears = 0;
  let fills = 0;
  const context = {
    setTransform() {}, clearRect() { clears++; }, save() {}, beginPath() {},
    rect() {}, clip() {}, fillRect() { fills++; }, strokeRect() {}, restore() {},
  };
  const size = { width: 200, height: 150 };
  const canvas = {
    width: 0, height: 0, getContext: () => context, getBoundingClientRect: () => size,
  } as unknown as HTMLCanvasElement;
  const document = new SparseDocument();
  document.setCell(0, 0, "A");
  const camera = { x: 0, y: 0, zoom: 1 };
  const viewport = { width: 800, height: 600 };
  const browser = { devicePixelRatio: 1 };
  let minimapZoom = 1;
  let currentDocument = document;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  try {
    const draw = () => drawMinimap(canvas, currentDocument, camera, viewport, minimapZoom);
    const first = draw();
    const firstFills = fills;
    assert.ok(firstFills > 0);
    assert.deepEqual(draw(), first);
    assert.equal(clears, 1);
    assert.equal(fills, firstFills);
    const edits = [
      () => document.setCell(2, 0, "B"),
      () => document.setStyle(0, 0, { ...DEFAULT_TEXT_STYLE, fontSize: 2 }),
      () => document.deleteCell(2, 0),
      () => { camera.x++; },
      () => { camera.y--; },
      () => { camera.zoom = 2; },
      () => { viewport.width++; },
      () => { viewport.height++; },
      () => { size.width++; },
      () => { size.height++; },
      () => { browser.devicePixelRatio = 2; },
      () => { minimapZoom = 4; },
      // A different document can have exactly the same content revision.
      () => {
        currentDocument = new SparseDocument();
        for (let i = 0; i < document.contentRevision; i++) currentDocument.setCell(i, 50, "Z");
        assert.equal(currentDocument.contentRevision, document.contentRevision);
      },
    ];
    for (const edit of edits) {
      const before: number = clears;
      edit();
      const transform = draw();
      assert.equal(clears, before + 1);
      assert.deepEqual(draw(), transform);
      assert.equal(clears, before + 1);
    }
    const before = clears;
    drawMinimap({ ...canvas } as HTMLCanvasElement, currentDocument, camera, viewport, minimapZoom);
    assert.equal(clears, before + 1);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
