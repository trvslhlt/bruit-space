// WASD walks relative to where the listener is facing (W forward, S back,
// A/D strafe), Q/E turn -- position and rotation are independent axes, so
// holding e.g. W and E together walks in a curve.

const KEYS = new Set(["w", "a", "s", "d", "q", "e"]);

export interface Axes {
  forward: number;
  strafe: number;
  turn: number;
}

/** Typing into a number field shouldn't also walk the listener around. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "TEXTAREA" ||
    (target.tagName === "INPUT" &&
      (target as HTMLInputElement).type !== "range" &&
      (target as HTMLInputElement).type !== "checkbox")
  );
}

export function createKeyboardControls(): { axes(): Axes } {
  const down = new Set<string>();

  window.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (KEYS.has(key)) {
      down.add(key);
      event.preventDefault();
    }
  });
  window.addEventListener("keyup", (event) => {
    down.delete(event.key.toLowerCase());
  });
  // A key released while the window wasn't focused never fires keyup, which
  // would leave the listener walking forever.
  window.addEventListener("blur", () => down.clear());

  const axis = (positive: string, negative: string): number =>
    (down.has(positive) ? 1 : 0) - (down.has(negative) ? 1 : 0);

  return {
    axes: () => ({
      forward: axis("w", "s"),
      strafe: axis("d", "a"),
      turn: axis("e", "q"),
    }),
  };
}
