import { distanceGain } from "bruit-kit/audio";
import {
  type RoomState,
  type SoundObject,
  clampToRoom,
  distanceToListener,
} from "./room";

const PADDING = 24;
const LISTENER_RADIUS_PX = 12;
const NOSE_DISTANCE_PX = 34;
const NOSE_RADIUS_PX = 7;
const LABEL_MAX_CHARS = 18;

type Drag =
  | { kind: "listener"; offsetX: number; offsetY: number }
  | { kind: "nose" }
  | { kind: "object"; id: number; offsetX: number; offsetY: number };

export interface RoomViewCallbacks {
  /** Something in the room was moved by the pointer. */
  onMove(): void;
  onSelect(id: number | null): void;
}

/** Top-down map of the room. Draws the state and turns pointer drags into
 * state changes -- it never touches audio. */
export class RoomView {
  private ctx: CanvasRenderingContext2D;
  private scale = 1;
  private originX = 0;
  private originY = 0;
  private drag: Drag | null = null;
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
    canvas.addEventListener("pointerup", this.endDrag);
    canvas.addEventListener("pointercancel", this.endDrag);
    canvas.addEventListener("lostpointercapture", this.endDrag);
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

  private pointerPosition(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private onPointerDown = (event: PointerEvent): void => {
    const pointer = this.pointerPosition(event);
    const roomPoint = this.toRoom(pointer.x, pointer.y);

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
        // Topmost (last-drawn) object wins when they overlap.
        for (let i = this.room.objects.length - 1; i >= 0; i--) {
          const object = this.room.objects[i];
          const at = this.toScreen(object.x, object.y);
          if (
            Math.hypot(pointer.x - at.x, pointer.y - at.y) <=
            this.objectRadiusPx(object) + 4
          ) {
            this.drag = {
              kind: "object",
              id: object.id,
              offsetX: object.x - roomPoint.x,
              offsetY: object.y - roomPoint.y,
            };
            break;
          }
        }
      }
    }

    if (this.drag) {
      this.canvas.setPointerCapture(event.pointerId);
      this.callbacks.onSelect(
        this.drag.kind === "object" ? this.drag.id : null,
      );
    } else {
      this.callbacks.onSelect(null);
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.drag) return;
    const pointer = this.pointerPosition(event);
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
    } else {
      const { id, offsetX, offsetY } = this.drag;
      const object = this.room.objects.find((o) => o.id === id);
      if (object) {
        Object.assign(
          object,
          clampToRoom(this.room, roomPoint.x + offsetX, roomPoint.y + offsetY),
        );
      }
    }
    this.callbacks.onMove();
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
      ctx.fillStyle = `rgba(76, 125, 255, ${0.2 + 0.8 * audibility})`;
      ctx.beginPath();
      ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
      ctx.fill();
      if (object.id === room.selectedId) {
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

    // Screen positions of the two draggable listener handles, so a
    // Playwright check can grab them without re-deriving this file's
    // layout math.
    this.canvas.dataset.listenerPx = `${listenerAt.x.toFixed(1)},${listenerAt.y.toFixed(1)}`;
    this.canvas.dataset.nosePx = `${nose.x.toFixed(1)},${nose.y.toFixed(1)}`;
  }
}
