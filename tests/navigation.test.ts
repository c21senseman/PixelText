import assert from "node:assert/strict";
import test from "node:test";
import { cameraAfterWheel, cameraMovementAxis, type ScrollAxis } from "../lib/navigation";

test("wheel follows the latest screen movement axis in either direction", () => {
  let camera = { x: 0, y: 0, zoom: 1 };
  let axis: ScrollAxis = "y";
  const viewport = { width: 800, height: 600 };
  const wheel = (deltaY: number) => cameraAfterWheel(camera, viewport, { deltaX: 0, deltaY, deltaMode: 0 }, axis);
  camera = wheel(48);
  assert.deepEqual(camera, { x: 0, y: 2, zoom: 1 });
  const horizontal = { ...camera, x: 10 };
  axis = cameraMovementAxis(camera, horizontal, axis);
  camera = horizontal;
  camera = wheel(48);
  assert.deepEqual(camera, { x: 14, y: 2, zoom: 1 });
  camera = wheel(-24);
  assert.deepEqual(camera, { x: 12, y: 2, zoom: 1 });
  const vertical = { ...camera, y: -10 };
  axis = cameraMovementAxis(camera, vertical, axis);
  camera = vertical;
  camera = wheel(-48);
  assert.deepEqual(camera, { x: 12, y: -12, zoom: 1 });
});

test("diagonal pans use screen pixels while ties, clicks and zoom retain the axis", () => {
  const camera = { x: 0, y: 0, zoom: 1 };
  assert.equal(cameraMovementAxis(camera, { ...camera, x: 3, y: 2 }, "x"), "y");
  assert.equal(cameraMovementAxis(camera, { ...camera, x: -5, y: -2 }, "y"), "x");
  assert.equal(cameraMovementAxis(camera, { ...camera, x: 4, y: 2 }, "x"), "x");
  assert.equal(cameraMovementAxis(camera, camera, "x"), "x");
  assert.equal(cameraMovementAxis(camera, { x: 0, y: 100, zoom: 2 }, "x"), "x");
});

test("wheel normalizes pixel, line and page units at each zoom", () => {
  const viewport = { width: 800, height: 600 };
  for (const zoom of [0.05, 1, 4]) {
    const camera = { x: 0, y: 0, zoom };
    const lineScroll = cameraAfterWheel(camera, viewport, { deltaX: 0, deltaY: 3, deltaMode: 1 }, "y");
    assert.ok(Math.abs(lineScroll.y - 3 / zoom) < 1e-9);
    assert.equal(cameraAfterWheel(camera, viewport, { deltaX: 0, deltaY: 1, deltaMode: 2 }, "x").x, 800 / (12 * zoom));
    assert.equal(cameraAfterWheel(camera, viewport, { deltaX: -24, deltaY: 0, deltaMode: 0 }, "x").x, -24 / (12 * zoom));
    assert.equal(cameraAfterWheel(camera, viewport, { deltaX: 0, deltaY: 0, deltaMode: 0 }, "x"), camera);
  }
});
