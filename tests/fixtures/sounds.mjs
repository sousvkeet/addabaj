import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Test sounds for noise cancellation, made on the spot (nothing recorded is
// kept in the repo): 48 kHz mono 16-bit WAV files.
// - noise: a fan (pink noise), traffic rumble (brown noise) and keyboard clicks.
// - voice: a voice saying vowels (a glottal pulse train through formant
//   filters), with its pitch moving, in syllables and phrases with pauses.
// - mix: the voice over the noise.
// The same seed makes the same files every time.

export const RATE = 48000;

function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rms = (x, from = 0, to = x.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / Math.max(1, to - from));
};
const scaleTo = (x, level) => {
  const k = level / (rms(x) || 1);
  for (let i = 0; i < x.length; i++) x[i] *= k;
  return x;
};
const db = (v) => 10 ** (v / 20);

export function noise(seconds, seed = 7) {
  const n = Math.round(seconds * RATE);
  const rnd = random(seed);
  const white = () => rnd() * 2 - 1;
  // Pink noise (Paul Kellet's filter): a fan, an air conditioner.
  const fan = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = white();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    fan[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  scaleTo(fan, db(-34));
  // Brown noise, slowly swelling: traffic going by.
  const rumble = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    last = (last + 0.02 * white()) / 1.02;
    rumble[i] = last * (0.6 + 0.4 * Math.sin((2 * Math.PI * i) / (RATE * 3.7)));
  }
  scaleTo(rumble, db(-36));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fan[i] + rumble[i];
  // Keyboard clicks: short bursts every 120 to 400 ms.
  for (let at = Math.round(0.2 * RATE); at < n; at += Math.round((0.12 + 0.28 * rnd()) * RATE)) {
    const len = Math.round(0.006 * RATE);
    const peak = db(-22) * (0.6 + 0.4 * rnd());
    for (let i = 0; i < len && at + i < n; i++) out[at + i] += white() * peak * Math.exp(-i / (0.0012 * RATE));
  }
  return out;
}

// Formants (Hz) and bandwidths of five vowels.
const VOWELS = {
  a: [[730, 90], [1090, 110], [2440, 160], [3300, 200]],
  e: [[530, 70], [1840, 100], [2480, 160], [3400, 200]],
  i: [[270, 60], [2290, 100], [3010, 170], [3500, 200]],
  o: [[570, 70], [840, 90], [2410, 160], [3300, 200]],
  u: [[300, 60], [870, 90], [2240, 160], [3300, 200]],
};

export function voice(seconds, seed = 11) {
  const n = Math.round(seconds * RATE);
  const rnd = random(seed);
  const out = new Float32Array(n);
  // Syllables: a vowel each, 160 to 300 ms, with short gaps; a pause after every five or so.
  const plan = [];
  let t = 0.3;
  let inPhrase = 0;
  while (t < seconds - 0.4) {
    const len = 0.16 + 0.14 * rnd();
    const names = Object.keys(VOWELS);
    plan.push({ from: t, to: t + len, vowel: VOWELS[names[Math.floor(rnd() * names.length)]] });
    t += len + 0.04 + 0.03 * rnd();
    if (++inPhrase >= 4 + Math.floor(rnd() * 3)) {
      t += 0.45 + 0.3 * rnd();
      inPhrase = 0;
    }
  }
  const state = [0, 0, 0, 0].map(() => [0, 0]);
  let phase = 0;
  let prev = 0;
  for (const s of plan) {
    const from = Math.round(s.from * RATE);
    const to = Math.min(n, Math.round(s.to * RATE));
    // Each formant: a two-pole resonator (Klatt's).
    const coef = s.vowel.map(([f, bw]) => {
      const c = -Math.exp((-2 * Math.PI * bw) / RATE);
      const b = 2 * Math.exp((-Math.PI * bw) / RATE) * Math.cos((2 * Math.PI * f) / RATE);
      return [1 - b - c, b, c];
    });
    for (let i = from; i < to; i++) {
      const time = i / RATE;
      // Pitch around 140 Hz, rising and falling over the phrase, a little unsteady.
      const f0 = 140 + 25 * Math.sin(2 * Math.PI * 0.45 * time) + 3 * (rnd() - 0.5);
      phase += f0 / RATE;
      if (phase >= 1) phase -= 1;
      // Rosenberg glottal pulse, open 60% of the cycle, with a breath of noise.
      const open = 0.6;
      let g = phase < open * 0.66 ? 0.5 * (1 - Math.cos((Math.PI * phase) / (open * 0.66))) : phase < open ? Math.cos((Math.PI * (phase - open * 0.66)) / (2 * open * 0.34)) : 0;
      g += 0.02 * (rnd() - 0.5);
      let x = g;
      coef.forEach(([a, b, c], k) => {
        const y = a * x + b * state[k][0] + c * state[k][1];
        state[k][1] = state[k][0];
        state[k][0] = y;
        x = y;
      });
      // Lips (a difference), and the syllable's rise and fall.
      const lips = x - prev;
      prev = x;
      const p = (i - from) / Math.max(1, to - from);
      const env = Math.sin(Math.PI * Math.min(1, p * 1.6, (1 - p) * 2.4));
      out[i] = lips * env;
    }
  }
  // Loud enough to be speech at a microphone: -20 dBFS while talking.
  const talking = out.filter((v) => v !== 0);
  const k = db(-20) / (rms(talking) || 1);
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

export function mix(seconds) {
  const a = voice(seconds);
  const b = noise(seconds);
  return a.map((v, i) => v + b[i]);
}

export function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** Writes noise.wav, voice.wav and mix.wav into `dir` and returns their paths. */
export function writeSounds(dir, seconds = 12) {
  mkdirSync(dir, { recursive: true });
  const files = { noise: noise(seconds), voice: voice(seconds), mix: mix(seconds) };
  return Object.fromEntries(
    Object.entries(files).map(([name, x]) => {
      const path = join(dir, `${name}.wav`);
      writeFileSync(path, wav(x));
      return [name, path];
    }),
  );
}
