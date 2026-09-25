import { distanceGain } from "bruit-kit/audio";
import {
  type RoomState,
  type SoundObject,
  clamp,
  clampToRoom,
  distanceToListener,
  objectsInRect,
} from "./room";

const PADDING = 24;
const LISTENER_RADIUS_PX = 12;
const NOSE_DISTANCE_PX = 34;
const NOSE_RADIUS_PX = 7;
const LABEL_MAX_CHARS = 18;
// Pointer travel below this still counts as a click rather than a drag.
const CLICK_SLOP_PX = 4;

type Drag =
  | { kind: "listener"; offsetX: number; offsetY: number }
  | { kind: "nose" }
  | { kind: "object"; id: number; offsetX: number; offsetY: number }
  // Dragging any member of a >1 selection moves the whole group as a
  // rigid shape: `origins` is every selected object's room-space position
  // when the drag began, and each pointermove re-derives one shared delta
  // from `startX`/`startY` rather than per-object offsets, so the group
  // can't distort relative to itself. `clickedId` is only for a plain
  // (undragged) click -- see onPointerUp -- and plays no part in movement.
  | {
      kind: "group";
      ids: number[];
      origins: Map<number, { x: number; y: number }>;
      clickedId: number;
      startX: number;
      startY: number;
    }
  // Room-space, not screen -- makes the final objectsInRect() test trivial
  // and keeps the rectangle correct if the view is resized mid-drag.
  | { kind: "marquee"; startX: number; startY: number; x: number; y: number };

export interface RoomViewCallbacks {
  /** Something in the room was moved by the pointer. */
  onMove(): void;
  /** Replaces the current selection (empty array clears it) -- a plain
   * click on one object, a click on empty floor, starting to drag the
   * listener, or releasing a marquee all go through this one callback. */
  onSelect(ids: number[]): void;
  /** An object was clicked (pressed and released without dragging). */
  onToggle(id: number): void;
  /** Right-click on `id`, at the given page coordinates (for positioning a
   * menu) -- never fires for a right-click on empty floor. */
  onContextMenu(id: number, pageX: number, pageY: number): void;
}

/** Top-down map of the room. Draws the state and turns pointer drags into
 * state changes -- it never touches audio. */
export class RoomView {
  private ctx: CanvasRenderingContext2D;
  private scale = 1;
  private originX = 0;
  private originY = 0;
  private drag: Drag | null = null;
  private pressStart = { x: 0, y: 0 };
  private dragged = false;
  private cssWidth = 0;
  private cssHeight = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private room: RoomState,
    private callbacks: RoomViewCallbacks,
  ) {
    this.ctx = canvas.getContext("2d")!;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.endDrag);
    canvas.addEventListener("lostpointercapture", this.endDrag);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  private layout(): void {
    const { width, height } = this.room;
    this.scale = Math.max(
      Math.min(
        (this.cssWidth - 2 * PADDING) / width,
        (this.cssHeight - 2 * PADDING) / height,
      ),
      1,
    );
    this.originX = (this.cssWidth - width * this.scale) / 2;
    this.originY = (this.cssHeight - height * this.scale) / 2;
  }

  private toScreen(x: number, y: number): { x: number; y: number } {
    return {
      x: this.originX + x * this.scale,
      y: this.originY + y * this.scale,
    };
  }

  private toRoom(px: number, py: number): { x: number; y: number } {
    return {
      x: (px - this.originX) / this.scale,
      y: (py - this.originY) / this.scale,
    };
  }

  private nosePosition(): { x: number; y: number } {
    const { listener } = this.room;
    const at = this.toScreen(listener.x, listener.y);
    return {
      x: at.x + Math.sin(listener.heading) * NOSE_DISTANCE_PX,
      y: at.y - Math.cos(listener.heading) * NOSE_DISTANCE_PX,
    };
  }

  private objectRadiusPx(object: SoundObject): number {
    return 6 + 8 * object.gain;
  }

  private pointerPosition(event: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** The topmost (last-drawn) object under a screen-space point, if any --
   * shared by pointerdown's hit-testing and the right-click menu. */
  private hitTestObject(pointer: { x: number; y: number }):
    | SoundObject
    | undefined {
    for (let i = this.room.objects.length - 1; i >= 0; i--) {
      const object = this.room.objects[i];
      const at = this.toScreen(object.x, object.y);
      if (
        Math.hypot(pointer.x - at.x, pointer.y - at.y) <=
        this.objectRadiusPx(object) + 4
      ) {
        return object;
      }
    }
    return undefined;
  }

  private onPointerDown = (event: PointerEvent): void => {
    // Right/middle click never starts a drag or a marquee -- the right
    // button opens the context menu instead, via its own contextmenu
    // listener below.
    if (event.button !== 0) return;

    const pointer = this.pointerPosition(event);
    const roomPoint = this.toRoom(pointer.x, pointer.y);
    this.pressStart = pointer;
    this.dragged = false;

    // Nose first: it sits close to the listener body and must stay
    // grabbable even when the two are drawn near each other.
    const nose = this.nosePosition();
    if (
      Math.hypot(pointer.x - nose.x, pointer.y - nose.y) <=
      NOSE_RADIUS_PX + 4
    ) {
      this.drag = { kind: "nose" };
    } else {
      const listener = this.toScreen(
        this.room.listener.x,
        this.room.listener.y,
      );
      if (
        Math.hypot(pointer.x - listener.x, pointer.y - listener.y) <=
        LISTENER_RADIUS_PX + 4
      ) {
        this.drag = {
          kind: "listener",
          offsetX: this.room.listener.x - roomPoint.x,
          offsetY: this.room.listener.y - roomPoint.y,
        };
      } else {
        const object = this.hitTestObject(pointer);
        if (object) {
          if (
            this.room.selectedIds.size > 1 &&
            this.room.selectedIds.has(object.id)
          ) {
            // Grabbing a member of an existing multi-selection drags the
            // whole selection together and leaves it as-is; grabbing
            // anything else (below) collapses to just that one object,
            // same as a plain click always has.
            const origins = new Map<number, { x: number; y: number }>();
            for (const id of this.room.selectedIds) {
              const selected = this.room.objects.find((o) => o.id === id);
              if (selected) origins.set(id, { x: selected.x, y: selected.y });
            }
            this.drag = {
              kind: "group",
              ids: [...this.room.selectedIds],
              origins,
              clickedId: object.id,
              startX: roomPoint.x,
              startY: roomPoint.y,
            };
          } else {
            this.drag = {
              kind: "object",
              id: object.id,
              offsetX: object.x - roomPoint.x,
              offsetY: object.y - roomPoint.y,
            };
          }
        } else {
          // Nothing hit: might become a marquee, might turn out to be a
          // plain click on empty floor -- either way, selection isn't
          // decided until pointerup knows which (see onPointerUp).
          this.drag = {
            kind: "marquee",
            startX: roomPoint.x,
            startY: roomPoint.y,
            x: roomPoint.x,
            y: roomPoint.y,
          };
        }
      }
    }

    this.canvas.setPointerCapture(event.pointerId);
    if (this.drag.kind === "object") {
      this.callbacks.onSelect([this.drag.id]);
    } else if (this.drag.kind === "listener" || this.drag.kind === "nose") {
      // Starting to move the listener clears any object selection, same as
      // clicking empty room floor.
      this.callbacks.onSelect([]);
    }
    // group: selection already covers every dragged id, so it's left
    // alone. marquee: deferred until pointerup knows what it enclosed.
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.drag) return;
    const pointer = this.pointerPosition(event);
    // Nothing moves until the pointer has travelled past the click slop, so
    // clicking an object to toggle it doesn't also nudge it.
    if (!this.dragged) {
      if (
        Math.hypot(
          pointer.x - this.pressStart.x,
          pointer.y - this.pressStart.y,
        ) <= CLICK_SLOP_PX
      ) {
        return;
      }
      this.dragged = true;
    }
    const roomPoint = this.toRoom(pointer.x, pointer.y);
    const { listener } = this.room;

    if (this.drag.kind === "nose") {
      const at = this.toScreen(listener.x, listener.y);
      listener.heading = Math.atan2(pointer.x - at.x, -(pointer.y - at.y));
    } else if (this.drag.kind === "listener") {
      Object.assign(
        listener,
        clampToRoom(
          this.room,
          roomPoint.x + this.drag.offsetX,
          roomPoint.y + this.drag.offsetY,
        ),
      );
    } else if (this.drag.kind === "object") {
      const { id, offsetX, offsetY } = this.drag;
      const object = this.room.objects.find((o) => o.id === id);
      if (object) {
        Object.assign(
          object,
          clampToRoom(this.room, roomPoint.x + offsetX, roomPoint.y + offsetY),
        );
      }
    } else if (this.drag.kind === "group") {
      const { ids, origins, startX, startY } = this.drag;
      // One shared delta for the whole group, clamped so its own extremes
      // (not each object's own position) stay inside the room -- clamping
      // per-object instead would let the group bunch up against a wall and
      // distort instead of moving as a rigid shape.
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const origin of origins.values()) {
        minX = Math.min(minX, origin.x);
        maxX = Math.max(maxX, origin.x);
        minY = Math.min(minY, origin.y);
        maxY = Math.max(maxY, origin.y);
      }
      const deltaX = clamp(roomPoint.x - startX, -minX, this.room.width - maxX);
      const deltaY = clamp(
        roomPoint.y - startY,
        -minY,
        this.room.height - maxY,
      );
      for (const id of ids) {
        const origin = origins.get(id);
        const object = this.room.objects.find((o) => o.id === id);
        if (origin && object) {
          object.x = origin.x + deltaX;
          object.y = origin.y + deltaY;
        }
      }
    } else {
      this.drag.x = roomPoint.x;
      this.drag.y = roomPoint.y;
    }
    this.callbacks.onMove();
  };

  private onPointerUp = (): void => {
    if (this.drag?.kind === "object" && !this.dragged) {
      this.callbacks.onToggle(this.drag.id);
    } else if (this.drag?.kind === "group" && !this.dragged) {
      // A plain click on a selected object still toggles just that one --
      // same as clicking any other object -- rather than the whole group.
      this.callbacks.onToggle(this.drag.clickedId);
    } else if (this.drag?.kind === "marquee") {
      const { startX, startY, x, y } = this.drag;
      const enclosed = this.dragged
        ? objectsInRect(this.room.objects, startX, startY, x, y)
        : [];
      this.callbacks.onSelect(enclosed.map((o) => o.id));
    }
    this.endDrag();
  };

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    const object = this.hitTestObject(this.pointerPosition(event));
    if (object) {
      this.callbacks.onContextMenu(object.id, event.clientX, event.clientY);
    }
  };

  private endDrag = (): void => {
    this.drag = null;
  };

  draw(): void {
    const { ctx, room } = this;
    this.layout();
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);

    const topLeft = this.toScreen(0, 0);
    const roomWidthPx = room.width * this.scale;
    const roomHeightPx = room.height * this.scale;

    ctx.fillStyle = "#1b1d22";
    ctx.fillRect(topLeft.x, topLeft.y, roomWidthPx, roomHeightPx);

    ctx.save();
    ctx.beginPath();
    ctx.rect(topLeft.x, topLeft.y, roomWidthPx, roomHeightPx);
    ctx.clip();

    ctx.strokeStyle = "#23262d";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < room.width; x++) {
      const px = topLeft.x + x * this.scale;
      ctx.moveTo(px, topLeft.y);
      ctx.lineTo(px, topLeft.y + roomHeightPx);
    }
    for (let y = 1; y < room.height; y++) {
      const py = topLeft.y + y * this.scale;
      ctx.moveTo(topLeft.x, py);
      ctx.lineTo(topLeft.x + roomWidthPx, py);
    }
    ctx.stroke();

    const listenerAt = this.toScreen(room.listener.x, room.listener.y);
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = "#3a4050";
    ctx.beginPath();
    ctx.arc(
      listenerAt.x,
      listenerAt.y,
      room.hearingRange * this.scale,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    ctx.strokeStyle = "#2c3038";
    ctx.lineWidth = 2;
    ctx.strokeRect(topLeft.x, topLeft.y, roomWidthPx, roomHeightPx);

    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    for (const object of room.objects) {
      const at = this.toScreen(object.x, object.y);
      const radius = this.objectRadiusPx(object);
      const audibility = object.muted
        ? 0
        : distanceGain(distanceToListener(room, object), room.hearingRange);
      ctx.beginPath();
      ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
      if (object.closed) {
        // Hollow ring: closed reads as "shut", filled reads as "open".
        ctx.fillStyle = `rgba(76, 125, 255, ${0.03 + 0.09 * audibility})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(76, 125, 255, ${0.25 + 0.4 * audibility})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(112, 156, 255, ${0.35 + 0.65 * audibility})`;
        ctx.fill();
      }
      if (room.selectedIds.has(object.id)) {
        ctx.strokeStyle = "#e4e6eb";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.fillStyle = object.muted ? "#5c616b" : "#9aa0ab";
      const label =
        object.name.length > LABEL_MAX_CHARS
          ? `${object.name.slice(0, LABEL_MAX_CHARS - 1)}…`
          : object.name;
      ctx.fillText(label, at.x, at.y + radius + 12);
    }

    const { heading } = room.listener;
    const nose = this.nosePosition();
    ctx.strokeStyle = "#e4e6eb";
    ctx.fillStyle = "#e4e6eb";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(listenerAt.x, listenerAt.y);
    ctx.lineTo(nose.x, nose.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(nose.x, nose.y, NOSE_RADIUS_PX, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(listenerAt.x, listenerAt.y);
    ctx.rotate(heading);
    ctx.beginPath();
    ctx.moveTo(0, -LISTENER_RADIUS_PX - 2);
    ctx.lineTo(LISTENER_RADIUS_PX, LISTENER_RADIUS_PX);
    ctx.lineTo(-LISTENER_RADIUS_PX, LISTENER_RADIUS_PX);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Drawn last (on top of everything, unclipped) so it's always visible
    // even started from the padding margin outside the room rect.
    if (this.drag?.kind === "marquee" && this.dragged) {
      const from = this.toScreen(this.drag.startX, this.drag.startY);
      const to = this.toScreen(this.drag.x, this.drag.y);
      const x = Math.min(from.x, to.x);
      const y = Math.min(from.y, to.y);
      const w = Math.abs(to.x - from.x);
      const h = Math.abs(to.y - from.y);
      ctx.fillStyle = "rgba(76, 125, 255, 0.15)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#4c7dff";
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
    }

    // Screen positions of everything clickable/draggable, so a Playwright
    // check can grab them without re-deriving this file's layout math.
    this.canvas.dataset.objects = JSON.stringify(
      room.objects.map((object) => {
        const at = this.toScreen(object.x, object.y);
        return {
          id: object.id,
          x: Number(at.x.toFixed(1)),
          y: Number(at.y.toFixed(1)),
          closed: object.closed,
        };
      }),
    );
    this.canvas.dataset.listenerPx = `${listenerAt.x.toFixed(1)},${listenerAt.y.toFixed(1)}`;
    this.canvas.dataset.nosePx = `${nose.x.toFixed(1)},${nose.y.toFixed(1)}`;
    this.canvas.dataset.selectedIds = JSON.stringify([...room.selectedIds]);
    // The room rect's own screen bounds, so a marquee-select check can pick
    // a point guaranteed to be outside the room (e.g. just above topLeft)
    // without having to re-derive layout()'s centering/scale math itself.
    this.canvas.dataset.roomRectPx = `${topLeft.x.toFixed(1)},${topLeft.y.toFixed(1)},${roomWidthPx.toFixed(1)},${roomHeightPx.toFixed(1)}`;
  }
}
