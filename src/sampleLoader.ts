import { decodeAiff } from "bruit-kit/audio";

const EXTENSIONS = [".aif", ".aiff", ".wav", ".mp3"];
const AIFF_EXTENSIONS = [".aif", ".aiff"];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

/** Audio files we know how to decode. Dotfiles are skipped on purpose:
 * macOS writes `._name.aif` AppleDouble stubs next to real files on
 * external/network drives, and they have the right extension but aren't
 * audio. */
export function pickAudioFiles(files: Iterable<File>): File[] {
  return [...files].filter(
    (file) =>
      !file.name.startsWith(".") && EXTENSIONS.includes(extensionOf(file.name)),
  );
}

export function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** AIFF is decoded by hand because Chrome's decodeAudioData can't read it;
 * everything else goes through the browser. */
export async function decodeFile(
  audioContext: AudioContext,
  file: File,
): Promise<AudioBuffer> {
  const data = await file.arrayBuffer();
  if (!AIFF_EXTENSIONS.includes(extensionOf(file.name))) {
    return audioContext.decodeAudioData(data);
  }
  const { sampleRate, channels } = decodeAiff(data);
  const buffer = audioContext.createBuffer(
    channels.length,
    channels[0].length,
    sampleRate,
  );
  channels.forEach((samples, channel) => {
    buffer.copyToChannel(samples, channel);
  });
  return buffer;
}
