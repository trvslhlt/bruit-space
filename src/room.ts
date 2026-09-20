/** Room coordinates are metres, x rightward and y downward (screen
 * convention) with (0, 0) at the top-left corner. `heading` is radians
 * clockwise from "up" on the map, so 0 faces the top wall. */
export interface Listener {
  x: number;
  y: number;
  heading: number;
}

export interface SoundObject {
  id: number;
  name: string;
  x: number;
  y: number;
  /** Loudness, 0..1 -- the same distance curve applies to every object, so
   * a louder one is simply still audible from farther away. */
  gain: number;
  muted: boolean;
}

export interface RoomState {
  width: number;
  height: number;
  /** Distance at which every object falls to silence. */
  hearingRange: number;
  listener: Listener;
  objects: SoundObject[];
  selectedId: number | null;
}

export const LISTENER_SPEED = 2; // metres/second
export const LISTENER_TURN_RATE = Math.PI / 2; // radians/second

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clampToRoom(
  room: RoomState,
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: clamp(x, 0, room.width), y: clamp(y, 0, room.height) };
}

export function distanceToListener(
  room: RoomState,
  object: SoundObject,
): number {
  return Math.hypot(object.x - room.listener.x, object.y - room.listener.y);
}

/** A random spot at least `minDistanceFromListener` from the listener, so
 * nothing spawns right on top of them -- falls back to whatever the last
 * try was rather than looping forever in a room too small to satisfy it. */
export function randomObjectPosition(
  room: RoomState,
  minDistanceFromListener: number,
): { x: number; y: number } {
  const margin = 0.5;
  let x = 0;
  let y = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    x = margin + Math.random() * Math.max(room.width - 2 * margin, 0);
    y = margin + Math.random() * Math.max(room.height - 2 * margin, 0);
    if (
      Math.hypot(x - room.listener.x, y - room.listener.y) >=
      minDistanceFromListener
    ) {
      break;
    }
  }
  return { x, y };
}
