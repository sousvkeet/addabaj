import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import simdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

// Noise cancellation for calls and room voice: RNNoise (xiph.org's neural
// network noise suppressor, as WebAssembly) cleans the microphone in an audio
// worklet, after the browser's own echo cancelling. Background noise (traffic,
// typing, fans, a television) goes; voices stay. It adds about 13 ms of delay.

let binary: Promise<ArrayBuffer> | null = null;

/** RNNoise, fetched once (about 150 KB) and checked to run here: a page that can't would send silence. */
function load() {
  binary ??= loadRnnoise({ url: wasmUrl, simdUrl }).then(async (b) => {
    await WebAssembly.compile(b);
    return b;
  });
  binary.catch(() => (binary = null));
  return binary;
}

const supported = () =>
  typeof AudioWorkletNode !== 'undefined' && typeof WebAssembly !== 'undefined' && typeof MediaStreamAudioDestinationNode !== 'undefined';

/**
 * The microphone cleaned of noise, as a new stream; or null where that can't
 * be done (an old browser, or a microphone whose rate the browser won't
 * convert), and the microphone is used as it is. Stopping the new stream's
 * track stops the microphone and the cleaning with it.
 */
export async function cancelNoise(mic: MediaStream): Promise<MediaStream | null> {
  const raw = mic.getAudioTracks()[0];
  if (!raw || !supported()) return null;
  let ctx: AudioContext | null = null;
  try {
    const wasmBinary = await load();
    // RNNoise works at 48 kHz.
    ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(workletUrl);
    const source = ctx.createMediaStreamSource(new MediaStream([raw]));
    const node = new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
    // One channel in, so one out: browsers often hand over a microphone as two identical channels, and
    // a second one left uncleaned (silent) would halve the voice when the two are mixed back.
    node.channelCount = 1;
    node.channelCountMode = 'explicit';
    node.channelInterpretation = 'speakers';
    const out = ctx.createMediaStreamDestination();
    out.channelCount = 1;
    out.channelCountMode = 'explicit';
    source.connect(node).connect(out);
    // A page needs a tap before it may play sound; joining a call is one, but if it isn't running, the cleaning would send silence.
    if (ctx.state !== 'running') await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]);
    if (ctx.state !== 'running') throw new Error('Audio is paused on this page');
    const audio = ctx;
    // Phones pause a page's sound now and then (a phone call coming in): it starts again by itself.
    audio.onstatechange = () => {
      if (audio.state === 'suspended') void audio.resume().catch(() => {});
    };
    const track = out.stream.getAudioTracks()[0];
    // It stands for the microphone: its name and settings (which device it is) are the microphone's.
    Object.defineProperty(track, 'label', { get: () => raw.label });
    track.getSettings = () => ({ ...raw.getSettings() });
    const stop = track.stop.bind(track);
    track.stop = () => {
      stop();
      node.destroy();
      source.disconnect();
      audio.onstatechange = null;
      void audio.close().catch(() => {});
      raw.stop();
    };
    return new MediaStream([track]);
  } catch (err) {
    console.warn('Noise cancellation is off: it could not start here.', err);
    void ctx?.close().catch(() => {});
    return null;
  }
}
