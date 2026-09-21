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

function sineSamples(frequency, seconds = 1) {
  const count = Math.floor(SAMPLE_RATE * seconds);
  return Array.from(
    { length: count },
    (_, i) => 0.5 * Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE),
  );
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
  // Every GainNode from createGain(), in creation order: a sound object's
  // voice creates its direct-path gain then its reverb-send gain, so the
  // last two are the most recently placed object's.
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

await page.goto(baseUrl);
// The button only exists if the browser left the AudioContext suspended.
await page.waitForSelector(".unlock-button, #app:not([hidden])");
if ((await page.locator(".unlock-button").count()) > 0) {
  await page.click(".unlock-button");
}
await page.waitForSelector("#app:not([hidden])");
ok("page loads and audio unlocks");

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
await page.setInputFiles("#folder-input", toneDir);
await waitForStatus(/^1 of 1 files placed/);
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
// shared (1 - d/range)^2 curve.
await setSlider("hearing-range", 40);
await page.click(`.object-row[data-id="${toneId}"] .object-name`);
async function voiceMix() {
  await page.waitForTimeout(400);
  const readout = await page.textContent("#selected-readout");
  const distance = Number(readout.match(/([\d.]+) m away/)[1]);
  const [direct, send] = await page.evaluate(() => [
    window.__gains.at(-2).gain.value,
    window.__gains.at(-1).gain.value,
  ]);
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
  const totalRatio = (direct + send) / (1 - t) ** 2;
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
rmSync(toneDir, { recursive: true, force: true });

if (errors.length > 0) fail(`console/page errors:\n  ${errors.join("\n  ")}`);
else ok("no console or page errors");

await browser.close();
rmSync(sampleDir, { recursive: true, force: true });
if (!process.exitCode) console.log("\nAll checks passed.");
