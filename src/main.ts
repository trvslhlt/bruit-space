import { distanceGain } from "bruit-kit/audio";
import { bindSlider, rangeControl } from "bruit-kit/ui";
import { unlockAudioContext } from "./audioContext";
import { createKeyboardControls } from "./keyboard";
import {
  LISTENER_SPEED,
  LISTENER_TURN_RATE,
  type RoomState,
  type SoundObject,
  clamp,
  clampToRoom,
  distanceToListener,
  randomObjectPosition,
} from "./room";
import { RoomView } from "./roomView";
import { decodeFile, pickAudioFiles, shuffled } from "./sampleLoader";
import {
  DEFAULT_CLOSED_CUTOFF_HZ,
  DEFAULT_MASTER_LEVEL,
  DEFAULT_TRANSITION_MS,
  SpatialEngine,
} from "./spatialEngine";

const MIN_SPAWN_DISTANCE_FROM_LISTENER = 1.5;

function query<T extends HTMLElement>(selector: string): T {
  return document.querySelector<T>(selector)!;
}

unlockAudioContext(query("#unlock")).then(async (audioContext) => {
  const engine = await SpatialEngine.create(audioContext);
  query("#app").hidden = false;

  const room: RoomState = {
    width: 12,
    height: 8,
    hearingRange: 8,
    // Starts at the bottom edge facing up, like just having climbed in
    // through the attic hatch.
    listener: { x: 6, y: 7, heading: 0 },
    objects: [],
    selectedId: null,
  };
  let dirty = true;

  const roomControlsEl = query("#room-controls");
  roomControlsEl.innerHTML =
    rangeControl("room-width", "Width (m)", 4, 40, 1, room.width) +
    rangeControl("room-height", "Height (m)", 4, 40, 1, room.height) +
    rangeControl(
      "hearing-range",
      "Hearing range (m)",
      2,
      40,
      1,
      room.hearingRange,
    );

  // Shrinking the room must not strand the listener or an object outside
  // it, where they'd be undraggable and unreachable.
  function keepInsideRoom(): void {
    Object.assign(
      room.listener,
      clampToRoom(room, room.listener.x, room.listener.y),
    );
    for (const object of room.objects) {
      Object.assign(object, clampToRoom(room, object.x, object.y));
    }
  }
  bindSlider("room-width", (value) => {
    room.width = value;
    keepInsideRoom();
    dirty = true;
  });
  bindSlider("room-height", (value) => {
    room.height = value;
    keepInsideRoom();
    dirty = true;
  });
  bindSlider("hearing-range", (value) => {
    room.hearingRange = value;
    dirty = true;
  });

  query("#reverb-controls").innerHTML =
    rangeControl("reverb-decay", "Decay (s)", 0.2, 8, 0.1, 2) +
    rangeControl("reverb-predelay", "Pre-delay (ms)", 0, 100, 1, 20) +
    rangeControl("reverb-damping", "Damping (Hz)", 500, 12000, 100, 6000) +
    rangeControl("reverb-level", "Level", 0, 1, 0.05, 0.5);
  bindSlider("reverb-decay", (value) => {
    engine.setReverb({ decaySeconds: value });
  });
  bindSlider("reverb-predelay", (value) => {
    engine.setReverb({ preDelayMs: value });
  });
  bindSlider("reverb-damping", (value) => {
    engine.setReverb({ dampingHz: value });
  });
  bindSlider(
    "reverb-level",
    (value) => {
      engine.setReverbLevel(value);
    },
    { hardMin: 0, hardMax: 1 },
  );

  query("#closed-controls").innerHTML =
    rangeControl(
      "closed-cutoff",
      "Cutoff (Hz)",
      100,
      8000,
      50,
      DEFAULT_CLOSED_CUTOFF_HZ,
    ) +
    rangeControl(
      "closed-transition",
      "Transition (ms)",
      50,
      3000,
      10,
      DEFAULT_TRANSITION_MS,
    );
  bindSlider("closed-cutoff", (value) => {
    engine.setClosedCutoff(value);
  });
  bindSlider("closed-transition", (value) => {
    engine.setTransitionMs(value);
  });

  query("#output-controls").innerHTML = rangeControl(
    "master-level",
    "Master",
    0,
    1,
    0.05,
    DEFAULT_MASTER_LEVEL,
  );
  bindSlider(
    "master-level",
    (value) => {
      engine.setMasterLevel(value);
    },
    { hardMin: 0, hardMax: 1 },
  );

  const view = new RoomView(query<HTMLCanvasElement>("#room-canvas"), room, {
    onMove: () => {
      dirty = true;
    },
    onSelect: (id) => select(id),
    onToggle: (id) => toggleClosed(id),
  });

  const objectListEl = query<HTMLUListElement>("#object-list");

  function select(id: number | null): void {
    room.selectedId = id;
    for (const row of objectListEl.querySelectorAll<HTMLElement>(
      ".object-row",
    )) {
      row.classList.toggle("is-selected", Number(row.dataset.id) === id);
    }
    dirty = true;
  }

  function applyStateButton(button: HTMLElement, object: SoundObject): void {
    button.textContent = object.closed ? "closed" : "open";
    button.classList.toggle("is-closed", object.closed);
  }

  function toggleClosed(id: number): void {
    const object = room.objects.find((o) => o.id === id);
    if (!object) return;
    object.closed = !object.closed;
    engine.setObjectClosed(object.id, object.closed);
    const button = objectListEl.querySelector<HTMLElement>(
      `.object-row[data-id="${id}"] .state-toggle`,
    );
    if (button) applyStateButton(button, object);
    dirty = true;
  }

  function renderObjectList(): void {
    objectListEl.innerHTML = "";
    for (const object of room.objects) {
      const row = document.createElement("li");
      row.className = "object-row";
      row.dataset.id = String(object.id);

      const name = document.createElement("span");
      name.className = "object-name";
      name.textContent = object.name;
      name.title = object.name;

      const gain = document.createElement("input");
      gain.type = "range";
      gain.min = "0";
      gain.max = "1";
      gain.step = "0.01";
      gain.value = String(object.gain);
      gain.title = "Loudness";
      gain.addEventListener("input", () => {
        object.gain = Number(gain.value);
        dirty = true;
      });

      const stateButton = document.createElement("button");
      stateButton.className = "state-toggle";
      stateButton.title = "Toggle open / closed";
      applyStateButton(stateButton, object);
      stateButton.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleClosed(object.id);
      });

      const muteLabel = document.createElement("label");
      muteLabel.title = "Mute";
      const mute = document.createElement("input");
      mute.type = "checkbox";
      mute.addEventListener("change", () => {
        object.muted = mute.checked;
        dirty = true;
      });
      muteLabel.append(mute, " M");

      row.append(name, gain, stateButton, muteLabel);
      row.addEventListener("click", () => select(object.id));
      objectListEl.appendChild(row);
    }
  }

  const folderInput = query<HTMLInputElement>("#folder-input");
  const maxObjectsInput = query<HTMLInputElement>("#max-objects");
  const reshuffleButton = query<HTMLButtonElement>("#reshuffle");
  const statusEl = query("#status");

  let allFiles: File[] = [];
  let loadToken = 0;
  let nextObjectId = 1;

  async function populate(): Promise<void> {
    if (allFiles.length === 0) return;
    // A newer populate() (reshuffle, or a changed cap) supersedes any
    // still-decoding one; the older one bails out at its next await
    // instead of adding its objects on top of the new set.
    const token = ++loadToken;
    const max = clamp(Math.round(Number(maxObjectsInput.value)) || 15, 1, 64);
    maxObjectsInput.value = String(max);

    statusEl.textContent = "Loading…";
    reshuffleButton.disabled = true;
    engine.clearObjects();
    room.objects = [];
    room.selectedId = null;
    renderObjectList();
    dirty = true;

    const decoded: { name: string; buffer: AudioBuffer }[] = [];
    let failed = 0;
    for (const file of shuffled(allFiles)) {
      if (decoded.length >= max) break;
      try {
        const buffer = await decodeFile(audioContext, file);
        if (token !== loadToken) return;
        decoded.push({ name: file.name.replace(/\.[^.]+$/, ""), buffer });
      } catch {
        if (token !== loadToken) return;
        failed++;
      }
    }

    for (const { name, buffer } of decoded) {
      const object = {
        id: nextObjectId++,
        name,
        ...randomObjectPosition(room, MIN_SPAWN_DISTANCE_FROM_LISTENER),
        gain: 0.3 + Math.random() * 0.5,
        muted: false,
        closed: true,
      };
      room.objects.push(object);
      engine.addObject(object.id, buffer, object.closed);
    }
    renderObjectList();
    reshuffleButton.disabled = false;
    dirty = true;
    const failedNote = failed > 0 ? ` (${failed} couldn't be decoded)` : "";
    statusEl.textContent = `${decoded.length} of ${allFiles.length} files placed${failedNote}`;
  }

  folderInput.addEventListener("change", () => {
    allFiles = pickAudioFiles(Array.from(folderInput.files ?? []));
    // Cleared so picking the same folder again still fires `change`.
    folderInput.value = "";
    if (allFiles.length === 0) {
      statusEl.textContent =
        "No .aif, .wav or .mp3 files found in that folder.";
      return;
    }
    populate();
  });
  maxObjectsInput.addEventListener("change", populate);
  reshuffleButton.addEventListener("click", populate);

  const recordToggle = query<HTMLButtonElement>("#record-toggle");
  const recordElapsed = query("#record-elapsed");
  const downloadLink = query<HTMLAnchorElement>("#download-link");
  let downloadUrl: string | null = null;

  recordToggle.addEventListener("click", async () => {
    if (!engine.recorder.isRecording()) {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = null;
      downloadLink.hidden = true;
      engine.recorder.start();
      recordToggle.classList.add("is-recording");
      recordToggle.textContent = "■ Stop";
      recordElapsed.hidden = false;
      return;
    }
    recordToggle.disabled = true;
    const blob = await engine.recorder.stop();
    recordToggle.disabled = false;
    recordToggle.classList.remove("is-recording");
    recordToggle.textContent = "● Record";
    recordElapsed.hidden = true;

    downloadUrl = URL.createObjectURL(blob);
    downloadLink.href = downloadUrl;
    downloadLink.download = `bruit-space-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.wav`;
    downloadLink.textContent = `Download .wav (${engine.recorder
      .elapsedSeconds()
      .toFixed(1)} s)`;
    downloadLink.hidden = false;
  });

  const listenerReadout = query("#listener-readout");
  const selectedReadout = query("#selected-readout");

  function refreshReadouts(): void {
    const { x, y, heading } = room.listener;
    const degrees = Math.round(((heading * 180) / Math.PI) % 360);
    listenerReadout.textContent = `listener x ${x.toFixed(1)} m · y ${y.toFixed(1)} m · heading ${(degrees + 360) % 360}°`;

    const selected = room.objects.find((o) => o.id === room.selectedId);
    if (!selected) {
      selectedReadout.textContent = "";
      return;
    }
    const distance = distanceToListener(room, selected);
    const heard = Math.round(
      distanceGain(distance, room.hearingRange) * selected.gain * 100,
    );
    const state = selected.closed ? "closed" : "open";
    selectedReadout.textContent = `${selected.name} · ${state} · ${distance.toFixed(1)} m away · heard at ${heard}%`;
  }

  const keys = createKeyboardControls();
  let lastFrame = performance.now();

  function frame(now: number): void {
    const dt = Math.min((now - lastFrame) / 1000, 0.1);
    lastFrame = now;

    const { forward, strafe, turn } = keys.axes();
    if (forward !== 0 || strafe !== 0 || turn !== 0) {
      const { listener } = room;
      listener.heading += turn * LISTENER_TURN_RATE * dt;
      // Normalised so walking diagonally isn't faster than straight.
      const step =
        (LISTENER_SPEED * dt) / Math.max(1, Math.hypot(forward, strafe));
      const moved = clampToRoom(
        room,
        listener.x +
          (Math.sin(listener.heading) * forward +
            Math.cos(listener.heading) * strafe) *
            step,
        listener.y +
          (-Math.cos(listener.heading) * forward +
            Math.sin(listener.heading) * strafe) *
            step,
      );
      Object.assign(listener, moved);
      dirty = true;
    }

    if (dirty) {
      dirty = false;
      engine.update(room);
      view.draw();
      refreshReadouts();
    }
    if (engine.recorder.isRecording()) {
      const seconds = Math.floor(engine.recorder.elapsedSeconds());
      recordElapsed.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
});
