export type LayoutMode = "random" | "grid" | "circle";
export const DEFAULT_LAYOUT_MODE: LayoutMode = "random";

/** Room-edge margin the grid/circle layouts keep clear, in metres -- same
 * value randomObjectPosition() (room.ts) already uses for the same
 * reason. Kept separate rather than imported: these layouts don't also
 * want randomObjectPosition's minimum-distance-from-listener behavior, so
 * there's no shared function to pull it from, just a shared constant. */
const DEFAULT_MARGIN = 0.5;

/** Position for the `index`-th of `count` objects on an evenly spaced
 * grid filling the room, `margin` kept clear of every wall. Row-major,
 * columns picked to keep cells roughly square; a short final row is left
 * short rather than stretched to fill it. Centered within its own cell
 * (not flush at a corner), so a single object lands in the room's
 * middle. */
export function gridPosition(
  index: number,
  count: number,
  width: number,
  height: number,
  margin: number = DEFAULT_MARGIN,
): { x: number; y: number } {
  const columns = Math.max(Math.ceil(Math.sqrt(count)), 1);
  const rows = Math.max(Math.ceil(count / columns), 1);
  const col = index % columns;
  const row = Math.floor(index / columns);
  const innerWidth = Math.max(width - 2 * margin, 0);
  const innerHeight = Math.max(height - 2 * margin, 0);
  return {
    x: margin + ((col + 0.5) / columns) * innerWidth,
    y: margin + ((row + 0.5) / rows) * innerHeight,
  };
}

/** Position for the `index`-th of `count` objects evenly spaced around a
 * circle centred in the room, radius the largest that still clears
 * `margin`. Angle 0 is straight up, going clockwise -- the same
 * convention Listener.heading uses -- so a single object sits on the
 * circle (at the top), not collapsed to the centre. */
export function circlePosition(
  index: number,
  count: number,
  width: number,
  height: number,
  margin: number = DEFAULT_MARGIN,
): { x: number; y: number } {
  const angle = (index / Math.max(count, 1)) * Math.PI * 2;
  const radius = Math.max(Math.min(width, height) / 2 - margin, 0);
  return {
    x: width / 2 + Math.sin(angle) * radius,
    y: height / 2 - Math.cos(angle) * radius,
  };
}
