import { cellMetrics, type Viewport } from "./renderer";
import type { Camera } from "./types";

export type ScrollAxis = "x" | "y";

export function cameraMovementAxis(
  previous: Camera,
  next: Camera,
  fallback: ScrollAxis,
): ScrollAxis {
  if (previous.zoom !== next.zoom) return fallback;
  const metrics = cellMetrics(previous);
  const dx = Math.abs(next.x - previous.x) * metrics.width;
  const dy = Math.abs(next.y - previous.y) * metrics.height;
  if (dx === dy) return fallback;
  return dx > dy ? "x" : "y";
}

export function cameraAfterWheel(
  camera: Camera,
  viewport: Viewport,
  wheel: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">,
  axis: ScrollAxis,
): Camera {
  const delta = Math.abs(wheel.deltaY) >= Math.abs(wheel.deltaX)
    ? wheel.deltaY : wheel.deltaX;
  const pixelsPerUnit = wheel.deltaMode === 1 ? 24
    : wheel.deltaMode === 2 ? (axis === "x" ? viewport.width : viewport.height)
    : 1;
  const metrics = cellMetrics(camera);
  const distance = delta * pixelsPerUnit / (axis === "x" ? metrics.width : metrics.height);
  if (!Number.isFinite(distance) || distance === 0) return camera;
  return { ...camera, [axis]: camera[axis] + distance };
}
