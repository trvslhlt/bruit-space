// The right-click menu for mute/loudness/open-closed, applied either to one
// object or to a whole multi-selection (see main.ts's contextMenuTargets).
// Same "one at a time, Escape/outside-click closes it" shape as bruit-kit's
// own rangeMenu.ts, but not that module itself -- this bundles several
// unrelated fields (a checkbox, a slider, a toggle button) rather than one
// numeric range, and is anchored at the click point like a normal OS
// context menu rather than centered like rangeMenu's modal dialog, so it
// isn't a good fit to generalize into bruit-kit's single-value menu.

import { bindSlider, rangeControl } from "bruit-kit/ui";

export interface ObjectMenuValues {
  gain: number;
  muted: boolean;
  closed: boolean;
}

export interface ObjectContextMenuOptions {
  /** Page coordinates to anchor the menu at -- the right-click point. */
  x: number;
  y: number;
  /** The target object's name, or "N objects" for a multi-selection. */
  label: string;
  /** Starting values shown -- the primary (right-clicked, or first
   * selected) object's own, even when other selected objects differ. */
  initial: ObjectMenuValues;
  /** Fired live, same as every other slider/checkbox in this app -- no
   * separate Apply step. Each is applied to every targeted object by the
   * caller, not just the one the initial values came from. */
  onGainChange: (value: number) => void;
  onMutedChange: (value: boolean) => void;
  onClosedChange: (value: boolean) => void;
}

// At most one of these is ever open at once, same reasoning as
// rangeMenu.ts's own closeActiveMenu: opening a second closes whatever the
// first was editing, like a native OS menu.
let closeActive: (() => void) | null = null;

export function openObjectContextMenu(options: ObjectContextMenuOptions): void {
  closeActive?.();

  const overlay = document.createElement("div");
  overlay.className = "object-menu-overlay";
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  overlay.addEventListener("contextmenu", (event) => {
    // Only the backdrop itself, not a right-click bubbling up from inside
    // the menu -- the Loudness slider has its own right-click "set exact
    // value" menu (bindSlider/rangeMenu.ts) that must be left alone, and it
    // doesn't stop propagation. This overlay sits above the whole page
    // (position: fixed; inset: 0), so a right-click anywhere else -- the
    // room canvas included -- lands here first and just closes the menu,
    // the same as a native context menu dismissing on an outside click; it
    // doesn't also open a fresh menu for whatever's underneath in the same
    // gesture.
    if (event.target !== overlay) return;
    event.preventDefault();
    close();
  });

  function close(): void {
    overlay.remove();
    document.removeEventListener("keydown", onKeydown);
    if (closeActive === close) closeActive = null;
  }
  closeActive = close;
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") close();
  }
  document.addEventListener("keydown", onKeydown);

  const menu = document.createElement("div");
  menu.className = "object-menu";
  overlay.appendChild(menu);
  // Attached to the live document now, before any content is filled in --
  // bindSlider below looks its input up via document.querySelector, which
  // (unlike menu.querySelector) can't find an element that only exists in
  // a detached subtree. Building out the rest of overlay's content after
  // it's already attached is fine; nothing here needs it to happen first.
  document.body.appendChild(overlay);

  const header = document.createElement("div");
  header.className = "object-menu-header";
  const title = document.createElement("span");
  title.textContent = options.label;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "object-menu-close";
  closeButton.textContent = "×";
  closeButton.addEventListener("click", close);
  header.append(title, closeButton);
  menu.appendChild(header);

  const body = document.createElement("div");
  body.className = "object-menu-body";
  menu.appendChild(body);

  const muteLabel = document.createElement("label");
  muteLabel.className = "object-menu-row";
  const muteInput = document.createElement("input");
  muteInput.type = "checkbox";
  muteInput.checked = options.initial.muted;
  muteInput.addEventListener("change", () => {
    options.onMutedChange(muteInput.checked);
  });
  muteLabel.append("Mute", muteInput);
  body.appendChild(muteLabel);

  const gainRow = document.createElement("div");
  gainRow.className = "object-menu-row object-menu-slider-row";
  gainRow.innerHTML = rangeControl(
    "object-menu-gain",
    "Loudness",
    0,
    1,
    0.01,
    options.initial.gain,
  );
  body.appendChild(gainRow);
  bindSlider(
    "object-menu-gain",
    (value) => {
      options.onGainChange(value);
    },
    { hardMin: 0, hardMax: 1 },
  );

  const stateButton = document.createElement("button");
  stateButton.type = "button";
  stateButton.title = "Toggle open / closed";
  stateButton.className =
    "object-menu-row object-menu-state-button state-toggle";
  let closed = options.initial.closed;
  // Same wording as the Objects list row's own state-toggle button
  // (main.ts's applyStateButton): the current state, not the action.
  function applyStateLabel(): void {
    stateButton.textContent = closed ? "closed" : "open";
    stateButton.classList.toggle("is-closed", closed);
  }
  applyStateLabel();
  stateButton.addEventListener("click", () => {
    closed = !closed;
    applyStateLabel();
    options.onClosedChange(closed);
  });
  body.appendChild(stateButton);

  // Anchored at the click point, clamped so it never overflows the
  // viewport -- sized after appending, since only then does it have a
  // real offsetWidth/Height to clamp against.
  const rect = menu.getBoundingClientRect();
  const left = Math.min(options.x, window.innerWidth - rect.width - 8);
  const top = Math.min(options.y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}
