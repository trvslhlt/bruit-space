// Manual (non-CI) golden-path browser check: load a folder of synthesized
// samples (WAVs plus one hand-built 24-bit AIFF, a `._` AppleDouble stub and
// a non-audio file that must both be ignored), confirm the object cap
// applies and every file -- AIFF included -- decodes, walk the listener
// with WASD/Q/E, drag the listener body and its heading handle on the
// canvas, shrink the room and confirm the listener stays inside it, and
// click an object to toggle it open/closed (a drag must not toggle), and
// confirm closing a bright tone really muffles it -- gradually, over the
// transition time, not as an instant snap -- and
// record a short clip that must download as a valid, non-silent stereo
// 16-bit PCM WAV -- asserting zero console/page errors throughout. Run
// after touching anything under src/ (requires `make up` first):
//
//   make verify
//
// What this can't check: whether front/back actually reads convincingly
// through headphones. That needs a manual listen.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://localhost:5173";
const SAMPLE_RATE = 44100;
const errors = [];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`ok: ${message}`);
}

function sineSamples(frequency, seconds = 1, amplitude = 0.5) {
  const count = Math.floor(SAMPLE_RATE * seconds);
  return Array.from(
    { length: count },
    (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE),
  );
}

// Independent of loudness.ts's own rmsOf, so the integration test below
// checks the app's wiring against a value computed a different way, not
// just against itself.
function rmsOfSamples(samples) {
  const sumSquares = samples.reduce((sum, s) => sum + s * s, 0);
  return Math.sqrt(sumSquares / samples.length);
}

function wavFile(samples) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) =>
    buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2),
  );
  return buffer;
}

// Mono 24-bit big-endian AIFF -- the shape of the real sample folder this
// app was built for, which Chrome's own decodeAudioData can't read.
function aiffFile(samples) {
  const dataSize = samples.length * 3;
  const buffer = Buffer.alloc(12 + 8 + 18 + 8 + 8 + dataSize);
  buffer.write("FORM", 0);
  buffer.writeUInt32BE(buffer.length - 8, 4);
  buffer.write("AIFF", 8);
  buffer.write("COMM", 12);
  buffer.writeUInt32BE(18, 16);
  buffer.writeUInt16BE(1, 20);
  buffer.writeUInt32BE(samples.length, 22);
  buffer.writeUInt16BE(24, 26);
  // 44100 as an 80-bit IEEE extended float.
  Buffer.from([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]).copy(buffer, 28);
  buffer.write("SSND", 38);
  buffer.writeUInt32BE(8 + dataSize, 42);
  samples.forEach((s, i) => {
    const value = Math.round(s * 0x7fffff);
    const offset = 54 + i * 3;
    buffer.writeUInt8((value >> 16) & 0xff, offset);
    buffer.writeUInt8((value >> 8) & 0xff, offset + 1);
    buffer.writeUInt8(value & 0xff, offset + 2);
  });
  return buffer;
}

const sampleDir = path.join(os.tmpdir(), "bruit-space-verify-samples");
rmSync(sampleDir, { recursive: true, force: true });
mkdirSync(sampleDir, { recursive: true });
for (let i = 0; i < 20; i++) {
  writeFileSync(
    path.join(sampleDir, `tone-${i}.wav`),
    wavFile(sineSamples(220 + 25 * i)),
  );
}
writeFileSync(
  path.join(sampleDir, "tone-aiff.aif"),
  aiffFile(sineSamples(330)),
);
writeFileSync(
  path.join(sampleDir, "._tone-junk.wav"),
  Buffer.from("not audio"),
);
writeFileSync(path.join(sampleDir, "notes.txt"), "not audio either");

const browser = await chromium.launch();
const page = await browser.newPage();
// Records every BiquadFilterNode the app constructs with `new` (one per
// sound object; bruit-kit's own effects use createBiquadFilter() and aren't
// caught), so the open/closed sweep can be read straight off the filter.
await page.addInitScript(() => {
  const Original = window.BiquadFilterNode;
  window.__filters = [];
  // Every GainNode from createGain(), in creation order. A newly placed
  // sound object creates its direct-path gain, then its reverb-send gain,
  // then (at window 1) its player's bus -- see toneGainIndex below.
  window.__gains = [];
  const originalCreateGain = BaseAudioContext.prototype.createGain;
  BaseAudioContext.prototype.createGain = function (...args) {
    const gain = originalCreateGain.apply(this, args);
    window.__gains.push(gain);
    return gain;
  };
  window.BiquadFilterNode = class extends Original {
    constructor(...args) {
      super(...args);
      window.__filters.push(this);
    }
  };
});
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (err) => errors.push(err.message));

const status = () => page.textContent("#status");
const waitForStatus = (pattern) =>
  page.waitForFunction(
    (source) =>
      new RegExp(source).test(document.querySelector("#status").textContent),
    pattern.source,
    { timeout: 20000 },
  );
async function readListener() {
  const text = await page.textContent("#listener-readout");
  const match = text.match(/x ([\d.]+) m · y ([\d.]+) m · heading (\d+)°/);
  if (!match) throw new Error(`unparseable listener readout: ${text}`);
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    heading: Number(match[3]),
  };
}
async function setSlider(id, value) {
  await page.evaluate(
    ([sliderId, v]) => {
      const el = document.querySelector(`#${sliderId}`);
      el.value = String(v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    [id, value],
  );
}
async function canvasPoint(datasetKey) {
  const box = await page.locator("#room-canvas").boundingBox();
  const raw = await page.getAttribute("#room-canvas", `data-${datasetKey}`);
  const [x, y] = raw.split(",").map(Number);
  return { x: box.x + x, y: box.y + y };
}
async function hold(key, ms) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
  await page.waitForTimeout(100);
}

// Records every AudioBufferSourceNode.start() call -- (when, offset,
// duration) and whether it's a native loop -- so the pass scheduling can be
// checked exactly, without inferring it from the audio.
await page.addInitScript(() => {
  window.__starts = [];
  const originalStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    window.__starts.push({
      args,
      loop: this.loop,
      bufferDuration: this.buffer?.duration,
    });
    return originalStart.apply(this, args);
  };
});

await page.goto(baseUrl);
// The button only exists if the browser left the AudioContext suspended.
await page.waitForSelector(".unlock-button, #app:not([hidden])");
if ((await page.locator(".unlock-button").count()) > 0) {
  await page.click(".unlock-button");
}
await page.waitForSelector("#app:not([hidden])");
ok("page loads and audio unlocks");

// The shipped defaults, read straight off the controls. Other checks below
// set what they depend on explicitly, so changing a default only ever needs
// this table updated.
const expectedDefaults = {
  "#room-width": "20",
  "#room-height": "20",
  "#hearing-range": "8",
  "#walk-speed": "2",
  "#turn-speed": "90",
  "#reverb-decay": "2",
  "#reverb-predelay": "20",
  "#reverb-damping": "6000",
  "#reverb-wet-near": "0.1",
  "#reverb-wet-far": "1",
  "#closed-cutoff": "300",
  "#closed-transition": "700",
  "#sample-window": "0.3",
  "#start-mode": "wander",
  "#wander-speed": "0.5",
  "#rest-probability": "0.1",
  "#rest-duration": "650",
  "#master-level": "0.9",
};
const wrongDefaults = [];
for (const [selector, expected] of Object.entries(expectedDefaults)) {
  const actual = await page.inputValue(selector);
  if (Number(actual) !== Number(expected) && actual !== expected) {
    wrongDefaults.push(`${selector}: ${actual} (expected ${expected})`);
  }
}
if (wrongDefaults.length === 0)
  ok("every control starts at its intended default");
else fail(`unexpected defaults: ${wrongDefaults.join("; ")}`);
if (!(await page.isDisabled("#wander-speed")))
  ok("wander speed is enabled in the default wander mode");
else fail("wander speed should be enabled by default");

await page.setInputFiles("#folder-input", sampleDir);
await waitForStatus(/^15 of 21 files placed/);
if ((await page.locator("#object-list li").count()) === 15) {
  ok("21 valid files found (dotfile and .txt ignored); default cap places 15");
} else {
  fail("expected 15 object rows at the default cap");
}

await page.fill("#max-objects", "64");
await page.dispatchEvent("#max-objects", "change");
await waitForStatus(/^21 of 21 files placed$/);
ok(
  "raising the cap places every file, including the 24-bit AIFF, with no decode failures",
);

await page.fill("#max-objects", "5");
await page.dispatchEvent("#max-objects", "change");
await waitForStatus(/^5 of 21 files placed/);
if ((await page.locator("#object-list li").count()) === 5) {
  ok("lowering the cap re-places just that many");
} else {
  fail("expected 5 object rows after lowering the cap");
}

await page.click("#reshuffle");
await waitForStatus(/^5 of 21 files placed/);
ok("reshuffle re-places the same count");

const canvasObjects = async () =>
  JSON.parse(await page.getAttribute("#room-canvas", "data-objects"));
const rowButton = (id) =>
  page.locator(`.object-row[data-id="${id}"] .state-toggle`);
async function isolatedObject() {
  const list = await canvasObjects();
  const listener = await canvasPoint("listener-px");
  const box = await page.locator("#room-canvas").boundingBox();
  const others = (o) => [
    ...list.filter((p) => p.id !== o.id),
    { x: listener.x - box.x, y: listener.y - box.y },
  ];
  const clearance = (o) =>
    Math.min(...others(o).map((p) => Math.hypot(p.x - o.x, p.y - o.y)));
  return list.reduce((best, o) => (clearance(o) > clearance(best) ? o : best));
}

const initialObjects = await canvasObjects();
if (
  initialObjects.length > 0 &&
  initialObjects.every((o) => o.closed) &&
  (await page.locator(".state-toggle.is-closed").count()) ===
    initialObjects.length
) {
  ok("every object starts closed");
} else {
  fail("new objects should all start closed");
}

const target = await isolatedObject();
const canvasBox = await page.locator("#room-canvas").boundingBox();
const targetAt = { x: canvasBox.x + target.x, y: canvasBox.y + target.y };
await page.mouse.click(targetAt.x, targetAt.y);
await page.waitForTimeout(100);
if (
  (await rowButton(target.id).textContent()) === "open" &&
  !(await canvasObjects()).find((o) => o.id === target.id).closed
) {
  ok("clicking an object on the map opens it");
} else {
  fail("click on a closed object should open it");
}
await page.mouse.click(targetAt.x, targetAt.y);
await page.waitForTimeout(100);
if ((await rowButton(target.id).textContent()) === "closed") {
  ok("clicking it again closes it");
} else {
  fail("second click should close the object again");
}

// Drag toward the middle of the map: an object placed near an edge would be
// clamped by the room boundary and move less than the pointer did.
const dragDy = target.y < canvasBox.height / 2 ? 40 : -40;
await page.mouse.move(targetAt.x, targetAt.y);
await page.mouse.down();
await page.mouse.move(targetAt.x, targetAt.y + dragDy, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(100);
const afterDrag = (await canvasObjects()).find((o) => o.id === target.id);
if (!afterDrag.closed) fail("dragging an object must not toggle it");
else if (Math.abs(afterDrag.y - (target.y + dragDy)) < 3) {
  ok("dragging an object moves it without toggling it");
} else {
  fail(
    `drag should move the object ${dragDy} px, got ${afterDrag.y - target.y}`,
  );
}

await rowButton(target.id).click();
if ((await rowButton(target.id).textContent()) === "open") {
  ok("the Objects list button toggles too");
} else {
  fail("list button should open the object");
}
await rowButton(target.id).click();

// Speed sliders scale keyboard movement. Heading is still exactly 0 here
// (nothing has turned the listener yet), so a strafe moves along x alone --
// no room-edge clamping risk regardless of speed, unlike after the turn
// test below changes heading.
const beforeFastWalk = await readListener();
await setSlider("walk-speed", 6);
await hold("d", 600);
const afterFastWalk = await readListener();
const fastWalkDistance = afterFastWalk.x - beforeFastWalk.x;
await hold("a", 600); // undo the strafe -- "a" is exactly d's opposite
await setSlider("walk-speed", 2); // back to default for the tests below
if (fastWalkDistance > 2.5) {
  ok(
    `Walk speed slider raises movement (6 m/s strafe moved ${fastWalkDistance.toFixed(2)} m in 0.6 s, default 2 m/s gives ~1.2 m)`,
  );
} else {
  fail(`walk speed slider should speed up movement, got ${fastWalkDistance} m`);
}

const beforeFastTurn = await readListener();
await setSlider("turn-speed", 270);
await hold("e", 500);
const afterFastTurn = await readListener();
const fastTurnDelta = afterFastTurn.heading - beforeFastTurn.heading;
await hold("q", 500); // undo the turn -- "q" is exactly e's opposite
await setSlider("turn-speed", 90); // back to default
if (fastTurnDelta > 100 && fastTurnDelta < 160) {
  ok(
    `Turn speed slider raises turn rate (270°/s turned ${fastTurnDelta}° in 0.5 s, default 90°/s gives ~45°)`,
  );
} else {
  fail(`turn speed slider should speed up turning, got ${fastTurnDelta}°`);
}
// Both undone: confirm rather than assume, since anything below that
// expects a specific x/heading depends on this having actually worked.
const restored = await readListener();
if (
  Math.abs(restored.x - beforeFastWalk.x) < 0.1 &&
  (restored.heading < 10 || restored.heading > 350)
) {
  ok("speed-test movement was fully undone before the fixed-speed tests below");
} else {
  fail(
    `speed-test undo left state behind: x ${beforeFastWalk.x} -> ${restored.x}, heading -> ${restored.heading}°`,
  );
}

const start = await readListener();
await hold("d", 600);
const afterStrafe = await readListener();
if (afterStrafe.x > start.x + 0.5) ok("D strafes right");
else fail(`D should move x right: ${start.x} -> ${afterStrafe.x}`);

await hold("w", 600);
const afterWalk = await readListener();
if (afterWalk.y < afterStrafe.y - 0.5)
  ok("W walks forward (up the map at heading 0)");
else fail(`W should move y up: ${afterStrafe.y} -> ${afterWalk.y}`);

await hold("e", 500);
const afterTurn = await readListener();
if (afterTurn.heading >= 20 && afterTurn.heading <= 70)
  ok(`E turns clockwise (${afterTurn.heading}°)`);
else fail(`E should turn ~45° clockwise, got ${afterTurn.heading}°`);

const noseStart = await canvasPoint("nose-px");
const listenerPoint = await canvasPoint("listener-px");
await page.mouse.move(noseStart.x, noseStart.y);
await page.mouse.down();
await page.mouse.move(listenerPoint.x + 100, listenerPoint.y, { steps: 5 });
await page.mouse.up();
const afterNoseDrag = await readListener();
if (afterNoseDrag.heading >= 88 && afterNoseDrag.heading <= 92)
  ok("dragging the heading handle right faces the listener east (90°)");
else fail(`nose drag should give ~90°, got ${afterNoseDrag.heading}°`);

const before = await readListener();
await page.mouse.move(listenerPoint.x, listenerPoint.y);
await page.mouse.down();
await page.mouse.move(listenerPoint.x - 60, listenerPoint.y, { steps: 5 });
await page.mouse.up();
const afterBodyDrag = await readListener();
if (afterBodyDrag.x < before.x - 0.5) ok("dragging the listener body moves it");
else fail(`body drag should decrease x: ${before.x} -> ${afterBodyDrag.x}`);

await setSlider("room-width", 4);
await page.waitForTimeout(150);
const shrunk = await readListener();
if (shrunk.x <= 4) ok("shrinking the room pulls the listener back inside");
else fail(`listener x=${shrunk.x} is outside a 4 m wide room`);

// Wide hearing range so every object is audible wherever the listener ended
// up -- the recording check below asserts non-silence.
await setSlider("hearing-range", 40);
await page.click("#record-toggle");
await page.waitForTimeout(1500);
await page.click("#record-toggle");
await page.waitForSelector("#download-link:not([hidden])", { timeout: 10000 });
const wav = await page.evaluate(async () => {
  const href = document.querySelector("#download-link").href;
  const buffer = await (await fetch(href)).arrayBuffer();
  const view = new DataView(buffer);
  const tag = (o) =>
    String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(o + i)));
  const frames = (buffer.byteLength - 44) / 4;
  let peak = 0;
  for (let i = 0; i < frames * 2; i++)
    peak = Math.max(peak, Math.abs(view.getInt16(44 + i * 2, true)));
  return {
    riff: tag(0),
    wave: tag(8),
    data: tag(36),
    riffSize: view.getUint32(4, true),
    dataSize: view.getUint32(40, true),
    size: buffer.byteLength,
    channels: view.getUint16(22, true),
    bits: view.getUint16(34, true),
    seconds: frames / view.getUint32(24, true),
    peak,
    filename: document.querySelector("#download-link").download,
  };
});
const validHeader =
  wav.riff === "RIFF" &&
  wav.wave === "WAVE" &&
  wav.data === "data" &&
  wav.riffSize === wav.size - 8 &&
  wav.dataSize === wav.size - 44 &&
  wav.channels === 2 &&
  wav.bits === 16;
if (validHeader) ok("recording downloads a valid stereo 16-bit PCM WAV");
else fail(`bad WAV header: ${JSON.stringify(wav)}`);
if (wav.seconds >= 1.2 && wav.seconds <= 3)
  ok(`recording length is right (${wav.seconds.toFixed(2)} s)`);
else fail(`expected ~1.5 s recording, got ${wav.seconds} s`);
if (wav.peak > 500) ok(`recording is not silent (peak ${wav.peak}/32767)`);
else fail(`recording is silent (peak ${wav.peak})`);
if (wav.peak < 32767) ok("recording doesn't clip at the default master level");
else fail("recording hit full scale -- default master level is too hot");
if (wav.filename.endsWith(".wav")) ok("download is named .wav");
else fail(`unexpected download name ${wav.filename}`);

// --- Closing muffles the sound, gradually. One 3 kHz tone, well above the
// default closed cutoff, so closing should take nearly all of it away. (Not
// higher: near 8 kHz the HRTF's own level swings by ~10x with the object's
// random direction, which makes absolute levels unreliable.)
const toneDir = path.join(os.tmpdir(), "bruit-space-verify-tone");
rmSync(toneDir, { recursive: true, force: true });
mkdirSync(toneDir, { recursive: true });
writeFileSync(path.join(toneDir, "bright.wav"), wavFile(sineSamples(3000)));
// Window 1 with no rests is a native loop, so the tone's player creates
// exactly one gain (its bus). Under the shipped defaults it would be a
// chain of passes creating a varying number, which the gain lookup below
// can't count on.
await setSlider("sample-window", 1);
await setSlider("rest-probability", 0);
await page.setInputFiles("#folder-input", toneDir);
await waitForStatus(/^1 of 1 files placed/);
// The tone object's direct and send gains are the two gains created just
// before its player's bus (window 1, so the player has made exactly one
// gain). Later passes create more, which is why
// this is captured now rather than counted from the end later.
const toneGainIndex = (await page.evaluate(() => window.__gains.length)) - 3;
await setSlider("hearing-range", 40);
const toneId = (await canvasObjects())[0].id;
await page
  .locator(`.object-row[data-id="${toneId}"] input[type="range"]`)
  .evaluate((el) => {
    el.value = "1";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
// The previous scene's reverb tail (2 s decay) is still ringing after the
// swap; measuring straight away would mostly measure that.
await page.waitForTimeout(2500);

async function recordWindows({ totalMs }) {
  await page.click("#record-toggle");
  await page.waitForTimeout(totalMs);
  await page.click("#record-toggle");
  await page.waitForSelector("#download-link:not([hidden])", {
    timeout: 10000,
  });
  // RMS per 100 ms window.
  return page.evaluate(async () => {
    const href = document.querySelector("#download-link").href;
    const buffer = await (await fetch(href)).arrayBuffer();
    const view = new DataView(buffer);
    const rate = view.getUint32(24, true);
    const frames = (buffer.byteLength - 44) / 4;
    const windowFrames = Math.floor(rate * 0.1);
    const rms = [];
    for (let start = 0; start + windowFrames <= frames; start += windowFrames) {
      let sum = 0;
      for (let i = start; i < start + windowFrames; i++) {
        const sample = view.getInt16(44 + i * 4, true) / 32768;
        sum += sample * sample;
      }
      rms.push(Math.sqrt(sum / windowFrames));
    }
    return rms;
  });
}
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

// Freshly placed, so this is the starting (closed) state, untouched.
const closedWindows = await recordWindows({ totalMs: 1200 });
const closedLevel = mean(closedWindows.slice(1));

await rowButton(toneId).click();
await page.waitForTimeout(1000);
const openWindows = await recordWindows({ totalMs: 1200 });
const openLevel = mean(openWindows.slice(1));
if (openLevel > 0.005) {
  ok(`opened bright tone is audible (rms ${openLevel.toFixed(3)})`);
} else {
  fail(`opened tone is silent (rms ${openLevel})`);
}
if (closedLevel < openLevel * 0.2) {
  ok(
    `a new object starts muffled (${(closedLevel / openLevel).toFixed(3)}x the open level)`,
  );
} else {
  fail(`closed level ${closedLevel} isn't well below open level ${openLevel}`);
}

// The sweep itself is checked on the filter's own frequency, sampled while
// it moves -- far less timing-sensitive than inferring it from recorded
// level windows, and it still catches a ramp that snaps instead of sweeping.
await setSlider("closed-transition", 1500);
// Long idle after the opening sweep finishes: a ramp that isn't anchored
// at "now" interpolates from that finished sweep's end, so the longer the
// idle, the more of the closing sweep it would skip -- this is what makes
// the check below sensitive to a missing anchor.
await page.waitForTimeout(8000);
const polling = page.evaluate(async (durationMs) => {
  const filter = window.__filters.at(-1);
  const samples = [];
  const begin = performance.now();
  while (performance.now() - begin < durationMs) {
    samples.push([performance.now() - begin, filter.frequency.value]);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return {
    samples,
    q: filter.Q.value,
    nyquist: filter.context.sampleRate / 2,
  };
}, 3000);
await page.waitForTimeout(500);
await rowButton(toneId).click();
const { samples, q, nyquist } = await polling;

const hz = samples.map(([, value]) => value);
const closedHz = Number(await page.inputValue("#closed-cutoff"));
const first = samples.find(([, value]) => value < nyquist * 0.98);
const last = samples.find(([, value]) => value <= closedHz * 1.02);
const midSweep = hz.filter((v) => v > closedHz * 1.05 && v < nyquist * 0.95);
const monotonic = hz.every((v, i) => i === 0 || v <= hz[i - 1] * 1.001);
const sweepMs = first && last ? last[0] - first[0] : Number.NaN;
// Continuity, not just duration: a ramp that snaps (jumps most of the way,
// then glides the rest) still spans a plausible first-to-last time. A real
// 1.5 s sweep over ~5 octaves falls ~5% per 25 ms sample; allow slack for
// scheduling jitter, but a snap is a drop of 90%+ in one step.
const smallestStep = Math.min(...hz.slice(1).map((v, i) => v / hz[i]));
if (
  Math.abs(hz[0] - nyquist) < nyquist * 0.01 &&
  Math.abs(hz.at(-1) - closedHz) < 25 &&
  monotonic &&
  smallestStep > 0.6 &&
  midSweep.length >= 20 &&
  sweepMs > 1100 &&
  sweepMs < 1900
) {
  ok(
    `closing sweeps the cutoff ${Math.round(hz[0])} -> ${Math.round(hz.at(-1))} Hz over ${Math.round(sweepMs)} ms (${midSweep.length} samples mid-sweep, monotonic, smallest step ${smallestStep.toFixed(2)}x)`,
  );
} else {
  fail(
    `bad closing sweep: start ${hz[0]}, end ${hz.at(-1)}, monotonic ${monotonic}, smallest step ${smallestStep.toFixed(2)}x, mid samples ${midSweep.length}, sweep ${sweepMs} ms`,
  );
}
if (Math.abs(q - -3.0103) < 0.01) {
  ok("the lowpass is Butterworth (no resonant peak)");
} else {
  fail(`unexpected filter Q ${q} dB`);
}
// --- The reverb share of an object's sound follows the near/far settings,
// interpolated linearly with distance. Read straight off the voice's two
// gains: direct = total * (1 - wet), send = total * wet, with total on the
// shared (1 - d/range)^2 curve times bright.wav's own normalization gain
// (every object's total now includes per-file loudness correction -- see
// the loudness normalization tests below -- so this scene's expected total
// has to account for it too, not just distance).
const brightToneNormGain = Math.min(
  4,
  Math.max(0.1, 0.1 / (0.5 / Math.sqrt(2))),
);
await setSlider("hearing-range", 40);
await page.click(`.object-row[data-id="${toneId}"] .object-name`);
async function voiceMix() {
  await page.waitForTimeout(400);
  const readout = await page.textContent("#selected-readout");
  const distance = Number(readout.match(/([\d.]+) m away/)[1]);
  const [direct, send] = await page.evaluate(
    (index) => [
      window.__gains[index].gain.value,
      window.__gains[index + 1].gain.value,
    ],
    toneGainIndex,
  );
  return { distance, direct, send };
}
for (const [near, far] of [
  [0, 1],
  [0.2, 0.8],
  [0.5, 0.5],
]) {
  await setSlider("reverb-wet-near", near);
  await setSlider("reverb-wet-far", far);
  const { distance, direct, send } = await voiceMix();
  const t = distance / 40;
  const expectedWet = near + (far - near) * t;
  const wet = send / (direct + send);
  const totalRatio = (direct + send) / ((1 - t) ** 2 * brightToneNormGain);
  if (Math.abs(wet - expectedWet) < 0.03 && Math.abs(totalRatio - 1) < 0.03) {
    ok(
      `wet fraction ${wet.toFixed(2)} at ${distance} m with near ${near} / far ${far} (expected ${expectedWet.toFixed(2)})`,
    );
  } else {
    fail(
      `reverb mix off at ${distance} m, near ${near} / far ${far}: wet ${wet.toFixed(3)} (expected ${expectedWet.toFixed(3)}), total/expected ${totalRatio.toFixed(3)}`,
    );
  }
}
// --- Sample window. First the pure planning math, exactly.
const plans = await page.evaluate(async () => {
  const { planPass, MIN_PASS_SECONDS } = await import("/src/passMath.ts");
  return {
    floor: MIN_PASS_SECONDS,
    lowest: planPass(10, 0.9, 0),
    highest: planPass(10, 0.9, 0.999999),
    whole: planPass(10, 1, 0.7),
    tiny: planPass(1.25, 0.001, 0.5),
    shortSample: planPass(0.03, 0.5, 0.5),
  };
});
const near = (a, b) => Math.abs(a - b) < 1e-3;
if (
  near(plans.lowest.offset, 0) &&
  near(plans.lowest.length, 9) &&
  plans.highest.offset <= 1 &&
  plans.highest.offset > 0.99 &&
  plans.highest.offset + plans.highest.length <= 10 &&
  near(plans.whole.offset, 0) &&
  near(plans.whole.length, 10) &&
  near(plans.tiny.length, plans.floor) &&
  near(plans.shortSample.length, 0.03) &&
  near(plans.shortSample.offset, 0)
) {
  ok(
    "window 0.9 on 10 s starts within 0..1 s and never overruns; 1 = whole sample; floor holds",
  );
} else {
  fail(`bad pass planning: ${JSON.stringify(plans)}`);
}

// Then what the app actually schedules, on the 1 s tone. It's closed after
// the sweep test; open it so the continuity check can hear it.
await rowButton(toneId).click();
await page.waitForTimeout(2000);
// Rests off and random starts, whatever the defaults are, so the overlap
// and distinct-start checks below mean what they say.
await setSlider("rest-probability", 0);
await page.selectOption("#start-mode", "random");
const startsBefore = await page.evaluate(() => window.__starts.length);
await setSlider("sample-window", 0.5);
await page.waitForTimeout(3500);
const passes = (
  await page.evaluate((from) => window.__starts.slice(from), startsBefore)
)
  .filter((entry) => entry.args.length === 3 && !entry.loop)
  .map(({ args: [when, offset, duration], bufferDuration }) => ({
    when,
    offset,
    duration,
    bufferDuration,
  }))
  .sort((a, b) => a.when - b.when);
const fitsInSample = passes.every(
  (pass) =>
    Math.abs(pass.duration - 0.5) < 0.005 &&
    pass.offset >= 0 &&
    pass.offset + pass.duration <= pass.bufferDuration + 0.001,
);
const distinctOffsets = new Set(passes.map((p) => p.offset.toFixed(3))).size;
const overlapping = passes.every(
  (pass, i) =>
    i === 0 || pass.when < passes[i - 1].when + passes[i - 1].duration,
);
if (passes.length >= 4 && fitsInSample && distinctOffsets >= 3) {
  ok(
    `window 0.5 on a 1 s sample: ${passes.length} passes of 0.5 s, ${distinctOffsets} distinct random starts, none past the end`,
  );
} else {
  fail(`bad passes: ${JSON.stringify(passes)}`);
}
if (overlapping)
  ok("each pass starts before the previous one ends (crossfaded, no gaps)");
else fail("passes leave a gap between them");

// Reverb off for this: phase-jumping fragments of a pure tone interfere in
// the reverb tail, which makes the level wander for reasons unrelated to
// gaps. Dry only, a dip can only come from the crossfade itself.
await setSlider("reverb-wet-near", 0);
await setSlider("reverb-wet-far", 0);
const windowLevels = await recordWindows({ totalMs: 2000 });
const sorted = [...windowLevels.slice(1, -1)].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
if (median > 0.005 && Math.min(...windowLevels.slice(1, -1)) > median * 0.6) {
  ok(
    `recorded level stays steady through the passes (min ${Math.min(...windowLevels.slice(1, -1)).toFixed(3)} vs median ${median.toFixed(3)})`,
  );
} else {
  fail(
    `level dips between passes: ${windowLevels.map((v) => v.toFixed(3)).join(" ")}`,
  );
}

// Window 1 goes back to a plain native loop, and stops scheduling passes.
await setSlider("sample-window", 1);
await page.waitForTimeout(1000);
const loopMark = await page.evaluate(() => window.__starts.length);
await page.waitForTimeout(3000);
const afterLoop = await page.evaluate(
  (from) => ({
    newStarts: window.__starts.length - from,
    lastIsLoop: window.__starts.at(-1).loop,
  }),
  loopMark,
);
if (afterLoop.newStarts === 0 && afterLoop.lastIsLoop) {
  ok("window 1 is a native loop again and schedules no further passes");
} else {
  fail(`window 1 should be a plain loop: ${JSON.stringify(afterLoop)}`);
}

await setSlider("sample-window", 0.3);
await page.waitForTimeout(1500);
const resumed = await page.evaluate(
  (from) => window.__starts.length - from,
  loopMark,
);
if (resumed >= 2) ok("dropping the window below 1 again resumes passes");
else fail(`expected passes to resume, got ${resumed} new starts`);

// --- Start modes. Wander first as pure math, with exact values.
const wander = await page.evaluate(async () => {
  const { advanceWander, initialWanderState, planPass } = await import(
    "/src/passMath.ts"
  );
  let state = initialWanderState(0.2, 0.8);
  let inRange = true;
  for (let i = 0; i < 5000; i++) {
    state = advanceWander(state, 0.7);
    if (
      state.position < 0 ||
      state.position > 1 ||
      state.target < 0 ||
      state.target > 1
    ) {
      inRange = false;
    }
  }
  return {
    glide: advanceWander({ position: 0, target: 1 }, 1, 0.123),
    held: advanceWander({ position: 0.3, target: 0.9 }, 0, 0.5),
    arrived: advanceWander({ position: 0.94, target: 1 }, 1, 0.25),
    inRange,
    planned: planPass(10, 0.5, 0.4),
  };
});
if (
  near(wander.glide.position, 0.4) &&
  near(wander.glide.target, 1) &&
  near(wander.held.position, 0.3) &&
  near(wander.held.target, 0.9) &&
  near(wander.arrived.target, 0.25) &&
  wander.inRange &&
  near(wander.planned.offset, 2)
) {
  ok(
    "wander glides toward its target, holds at speed 0, retargets on arrival, and stays in range",
  );
} else {
  fail(`bad wander math: ${JSON.stringify(wander)}`);
}

// Then what the app schedules. Window 0.5 on the 1 s tone leaves a 0.5 s
// start range; at speed 0.5 a pass can move the start by at most
// 0.4 * 0.5^2 = 0.1 of that range, i.e. 0.05 s.
async function passesSince(from) {
  return (await page.evaluate((index) => window.__starts.slice(index), from))
    .filter((entry) => entry.args.length === 3 && !entry.loop)
    .map(({ args: [when, offset, duration] }) => ({ when, offset, duration }))
    .sort((a, b) => a.when - b.when);
}
const offsetSteps = (list) =>
  list.slice(1).map((pass, i) => Math.abs(pass.offset - list[i].offset));

await setSlider("sample-window", 0.5);
if (await page.isDisabled("#wander-speed"))
  ok("wander speed is disabled in random mode");
else fail("wander speed should be disabled in random mode");
await page.selectOption("#start-mode", "wander");
await setSlider("wander-speed", 0.5);
if (!(await page.isDisabled("#wander-speed")))
  ok("wander speed is enabled in wander mode");
else fail("wander speed should be enabled in wander mode");
await page.waitForTimeout(700);
const wanderMark = await page.evaluate(() => window.__starts.length);
await page.waitForTimeout(4500);
const wandering = await passesSince(wanderMark);
const wanderSteps = offsetSteps(wandering);
if (
  wandering.length >= 6 &&
  Math.max(...wanderSteps) <= 0.051 &&
  Math.max(...wanderSteps) > 1e-4
) {
  ok(
    `wander drifts: ${wandering.length} passes, no start moved more than ${Math.max(...wanderSteps).toFixed(3)} s (limit 0.05 s) but they do move`,
  );
} else {
  fail(
    `bad wander passes: steps ${wanderSteps.map((v) => v.toFixed(3)).join(" ")}`,
  );
}

// Speed 0 holds the start still. Give passes already queued under the old
// speed time to play out first.
await setSlider("wander-speed", 0);
await page.waitForTimeout(2500);
const holdMark = await page.evaluate(() => window.__starts.length);
await page.waitForTimeout(3500);
const held = await passesSince(holdMark);
const heldOffsets = held.map((pass) => pass.offset);
if (
  held.length >= 4 &&
  Math.max(...heldOffsets) - Math.min(...heldOffsets) < 1e-9
) {
  ok(
    `speed 0 holds the start still (${held.length} passes, all at ${heldOffsets[0].toFixed(3)} s)`,
  );
} else {
  fail(
    `speed 0 should hold the start: ${heldOffsets.map((v) => v.toFixed(3)).join(" ")}`,
  );
}

// And random mode still jumps: independent uniform starts over a 0.5 s
// range move by more than 0.06 s between some pair of passes.
await page.selectOption("#start-mode", "random");
if (await page.isDisabled("#wander-speed"))
  ok("wander speed is disabled again in random mode");
else fail("wander speed should be disabled again in random mode");
await page.waitForTimeout(700);
const randomMark = await page.evaluate(() => window.__starts.length);
await page.waitForTimeout(4500);
const jumping = await passesSince(randomMark);
const jumpSteps = offsetSteps(jumping);
if (jumping.length >= 6 && Math.max(...jumpSteps) > 0.06) {
  ok(
    `random mode still jumps (largest step ${Math.max(...jumpSteps).toFixed(3)} s)`,
  );
} else {
  fail(
    `random mode should jump: steps ${jumpSteps.map((v) => v.toFixed(3)).join(" ")}`,
  );
}

// --- Rests. Pure first: a rest is `chance < probability` of a uniformly
// random time up to the max.
const restMath = await page.evaluate(async () => {
  const { planRest } = await import("/src/passMath.ts");
  return {
    never: planRest(0, 2, 0, 0.5),
    always: planRest(1, 2, 0.999, 0.5),
    longest: planRest(0.3, 2, 0.29, 1),
    missed: planRest(0.3, 2, 0.31, 1),
    noMax: planRest(1, 0, 0, 0.5),
  };
});
if (
  near(restMath.never, 0) &&
  near(restMath.always, 1) &&
  near(restMath.longest, 2) &&
  near(restMath.missed, 0) &&
  near(restMath.noMax, 0)
) {
  ok("rest planning: probability gates it, duration is uniform up to the max");
} else {
  fail(`bad rest math: ${JSON.stringify(restMath)}`);
}

// Then what the app schedules, on the 1 s tone at window 0.5. The gap
// between one pass ending and the next starting is the rest; a crossfaded
// pass overlaps the previous one, so its gap is negative.
const gapsOf = (list) =>
  list.slice(1).map((pass, i) => pass.when - (list[i].when + list[i].duration));

// Max 800 ms, not longer: passes are recorded as they're scheduled, so the
// count in a fixed window depends on the average pass-plus-rest time, and a
// 2 s max leaves it borderline (4 or 5) for the >= 5 check below.
await setSlider("rest-probability", 1);
await setSlider("rest-duration", 800);
await page.waitForTimeout(800);
const allRestMark = await page.evaluate(() => window.__starts.length);
await page.waitForTimeout(8000);
const allRests = await passesSince(allRestMark);
const allRestGaps = gapsOf(allRests);
if (
  allRests.length >= 5 &&
  allRestGaps.every((gap) => gap >= -1e-6 && gap <= 0.801) &&
  Math.max(...allRestGaps) > 0.15
) {
  ok(
    `rest probability 1: every pass is followed by a rest (${allRestGaps.map((g) => g.toFixed(2)).join(", ")} s, max 0.8)`,
  );
} else {
  fail(
    `bad rests at probability 1: ${allRestGaps.map((g) => g.toFixed(3)).join(" ")}`,
  );
}

await setSlider("rest-probability", 0.5);
await setSlider("rest-duration", 400);
await page.waitForTimeout(800);
const halfRestMark = await page.evaluate(() => window.__starts.length);
await page.waitForTimeout(7000);
const halfRests = await passesSince(halfRestMark);
const halfRestGaps = gapsOf(halfRests);
if (
  halfRests.length >= 10 &&
  halfRestGaps.some((gap) => gap < -0.01) &&
  halfRestGaps.some((gap) => gap > 0.01) &&
  halfRestGaps.every((gap) => gap <= 0.401)
) {
  ok(
    `rest probability 0.5: ${halfRestGaps.filter((g) => g > 0.01).length} of ${halfRestGaps.length} passes followed by a rest, the rest crossfaded, none over 0.4 s`,
  );
} else {
  fail(
    `bad rests at probability 0.5: ${halfRestGaps.map((g) => g.toFixed(3)).join(" ")}`,
  );
}

await setSlider("rest-probability", 0);
await page.waitForTimeout(800);
const noRestMark = await page.evaluate(() => window.__starts.length);
await page.waitForTimeout(3000);
const noRests = await passesSince(noRestMark);
if (noRests.length >= 4 && gapsOf(noRests).every((gap) => gap < 0)) {
  ok("rest probability 0: back to crossfaded passes with no gaps");
} else {
  fail(
    `rests should be off: ${gapsOf(noRests)
      .map((g) => g.toFixed(3))
      .join(" ")}`,
  );
}

// At window 1 a native loop has no end-of-loop to rest after, so rests
// turn it into full-length passes; rests off returns it to a native loop.
await setSlider("sample-window", 1);
await setSlider("rest-probability", 1);
await setSlider("rest-duration", 300);
await page.waitForTimeout(1000);
const fullMark = await page.evaluate(() => window.__starts.length);
await page.waitForTimeout(4500);
const fullPasses = await passesSince(fullMark);
if (
  fullPasses.length >= 3 &&
  fullPasses.every((pass) => near(pass.offset, 0) && near(pass.duration, 1))
) {
  ok(
    `window 1 with rests plays ${fullPasses.length} full-length passes, resting between`,
  );
} else {
  fail(
    `window 1 with rests should chain full passes: ${JSON.stringify(fullPasses)}`,
  );
}
await setSlider("rest-probability", 0);
await page.waitForTimeout(1000);
const backToLoopMark = await page.evaluate(() => window.__starts.length);
await page.waitForTimeout(2500);
const backToLoop = await page.evaluate(
  (from) => ({
    newStarts: window.__starts.length - from,
    lastIsLoop: window.__starts.at(-1).loop,
  }),
  backToLoopMark,
);
if (backToLoop.newStarts === 0 && backToLoop.lastIsLoop) {
  ok("window 1 with rests off is a native loop again");
} else {
  fail(`should be a native loop again: ${JSON.stringify(backToLoop)}`);
}

rmSync(toneDir, { recursive: true, force: true });

// --- Per-file loudness normalization. Pure math first, exact values.
const loudness = await page.evaluate(async () => {
  const {
    rmsOf,
    normalizationGain,
    TARGET_RMS,
    MIN_NORMALIZATION_GAIN,
    MAX_NORMALIZATION_GAIN,
  } = await import("/src/loudness.ts");
  return {
    rmsFlat: rmsOf([new Float32Array([1, -1, 1, -1])]),
    rmsEmpty: rmsOf([]),
    atTarget: normalizationGain(TARGET_RMS),
    nearSilent: normalizationGain(1e-9),
    maxGain: MAX_NORMALIZATION_GAIN,
    // Only reachable with a non-default target -- see loudness.ts -- so
    // exercised that way here rather than with real audio.
    hypotheticalLoud: normalizationGain(2, 0.1),
    minGain: MIN_NORMALIZATION_GAIN,
  };
});
if (
  near(loudness.rmsFlat, 1) &&
  near(loudness.rmsEmpty, 0) &&
  near(loudness.atTarget, 1) &&
  near(loudness.nearSilent, loudness.maxGain) &&
  near(loudness.hypotheticalLoud, loudness.minGain)
) {
  ok(
    "loudness math: RMS is exact, normalizing to the target is a no-op at the target, both clamps hold",
  );
} else {
  fail(`bad loudness math: ${JSON.stringify(loudness)}`);
}

// Then the actual wiring: a quiet and a loud tone, each loaded alone, read
// off the real direct-gain node -- same approach as the wet-fraction test.
async function loadSoloTone(amplitude) {
  const dir = path.join(
    os.tmpdir(),
    `bruit-space-verify-loudness-${amplitude}`,
  );
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const samples = sineSamples(1000, 1, amplitude);
  writeFileSync(path.join(dir, "tone.wav"), wavFile(samples));
  // Window 1, no rests: exactly one addObject call, so the player's bus is
  // the one gain created after this object's direct/send pair (see the
  // closing-sweep scene above, same trick).
  await setSlider("sample-window", 1);
  await setSlider("rest-probability", 0);
  await page.setInputFiles("#folder-input", dir);
  await waitForStatus(/^1 of 1 files placed/);
  const gainIndex = (await page.evaluate(() => window.__gains.length)) - 3;
  const id = (await canvasObjects())[0].id;
  await page
    .locator(`.object-row[data-id="${id}"] input[type="range"]`)
    .evaluate((el) => {
      el.value = "1";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await rowButton(id).click(); // starts closed; open it so nothing is filtered
  await page.click(`.object-row[data-id="${id}"] .object-name`); // for #selected-readout
  await setSlider("reverb-wet-near", 0);
  await setSlider("reverb-wet-far", 0);
  await setSlider("hearing-range", 40);
  await page.waitForTimeout(400);
  const distance = Number(
    (await page.textContent("#selected-readout")).match(/([\d.]+) m away/)[1],
  );
  const directGain = await page.evaluate(
    (index) => window.__gains[index].gain.value,
    gainIndex,
  );
  rmSync(dir, { recursive: true, force: true });
  // Isolates the measured normalization gain: directGain = 1 (slider) *
  // normGain * (1 - distance/range)^2 (ROLLOFF_EXPONENT 2, wet 0).
  const measuredNormGain = directGain / (1 - distance / 40) ** 2;
  const rms = rmsOfSamples(samples);
  // TARGET_RMS / rms, clamped the same way loudness.ts's normalizationGain
  // does -- matters for the quiet tone below, where the raw ratio exceeds
  // the +12 dB ceiling.
  const expectedNormGain = Math.min(4, Math.max(0.1, 0.1 / rms));
  return { measuredNormGain, expectedNormGain, rms };
}

const quiet = await loadSoloTone(0.02);
const loud = await loadSoloTone(0.9);
if (
  Math.abs(quiet.measuredNormGain - quiet.expectedNormGain) /
    quiet.expectedNormGain <
    0.03 &&
  Math.abs(loud.measuredNormGain - loud.expectedNormGain) /
    loud.expectedNormGain <
    0.03
) {
  ok(
    `normalization is wired in: quiet tone measured ${quiet.measuredNormGain.toFixed(2)}x (expected ${quiet.expectedNormGain.toFixed(2)}x), loud tone ${loud.measuredNormGain.toFixed(2)}x (expected ${loud.expectedNormGain.toFixed(2)}x)`,
  );
} else {
  fail(
    `normalization gain off: quiet measured ${quiet.measuredNormGain}, expected ${quiet.expectedNormGain}; loud measured ${loud.measuredNormGain}, expected ${loud.expectedNormGain}`,
  );
}
// A looser, relative tolerance than near()'s: the smoothed gain settles
// asymptotically (setTargetAtTime), so it's very close to but not bit-exact
// at 4 after a fixed wait.
if (Math.abs(quiet.measuredNormGain - 4) / 4 < 0.01) {
  ok(
    `the very quiet tone hits the +12 dB boost ceiling (${quiet.measuredNormGain.toFixed(3)}x)`,
  );
} else {
  fail(
    `expected the quiet tone to clamp at 4x, measured ${quiet.measuredNormGain}`,
  );
}
// The actual point of normalization: after correction, both tones should
// sound close to the same level, even though their raw amplitudes differ
// 45x (0.9 / 0.02). The loud tone lands exactly on target (its correction
// isn't clamped); the quiet one is clamped short of the target but still
// much closer to it than its raw level was.
const TARGET_RMS = 0.1;
const loudEffective = loud.rms * loud.measuredNormGain;
const quietEffective = quiet.rms * quiet.measuredNormGain;
const quietRawGapFromTarget = Math.abs(TARGET_RMS - quiet.rms);
const quietCorrectedGapFromTarget = Math.abs(TARGET_RMS - quietEffective);
if (
  near(loudEffective, TARGET_RMS) &&
  quietCorrectedGapFromTarget < quietRawGapFromTarget * 0.75
) {
  ok(
    `normalized level converges toward the target: loud tone lands at ${loudEffective.toFixed(3)} (target ${TARGET_RMS}), quiet tone moves from ${quiet.rms.toFixed(4)} to ${quietEffective.toFixed(4)}`,
  );
} else {
  fail(
    `normalization should bring both tones toward ${TARGET_RMS}: loud effective ${loudEffective}, quiet raw ${quiet.rms} -> corrected ${quietEffective}`,
  );
}

if (errors.length > 0) fail(`console/page errors:\n  ${errors.join("\n  ")}`);
else ok("no console or page errors");

await browser.close();
rmSync(sampleDir, { recursive: true, force: true });
if (!process.exitCode) console.log("\nAll checks passed.");
