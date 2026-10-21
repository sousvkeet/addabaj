// Many movie files carry sound browsers can't play: Dolby Digital (AC-3),
// Dolby Digital Plus (E-AC-3), DTS and Dolby TrueHD. Chrome then plays the
// picture in silence, so a live stream of the file would have no sound.
//
// For those files the host's browser converts the sound itself, with FFmpeg
// compiled to WebAssembly (about 32 MB, downloaded only when a file needs it,
// then cached). Nothing is uploaded: the file is read where it is. The sound
// is converted a minute at a time, a few minutes ahead of the picture, played
// in a hidden <audio> kept in step with the video, and that is what viewers hear.
// Converting runs about 30 times faster than playback, so a minute takes ~2 s.

import type { FFmpeg } from '@ffmpeg/ffmpeg';

export type SoundInfo = {
  /** e.g. "Dolby Digital 5.1" */
  label: string;
  codec: string;
};

/** Sound formats browsers can play, so they never need converting. */
const PLAYABLE = /^(aac|mp3|opus|vorbis|flac|pcm_)/;
const NAMES: Record<string, string> = {
  ac3: 'Dolby Digital',
  eac3: 'Dolby Digital Plus',
  truehd: 'Dolby TrueHD',
  dts: 'DTS',
  dca: 'DTS',
  mlp: 'Dolby TrueHD',
};

// AAC in fragmented MP4: every browser's MediaSource plays it, and FFmpeg's own AAC
// encoder runs fine in WebAssembly (this build's Opus encoder crashes).
const MIME = 'audio/mp4; codecs="mp4a.40.2"';
/** The first piece is short so sound starts quickly; later ones are longer. */
const FIRST_CHUNK = 12;
const CHUNK = 60;
/** How far ahead of the picture to keep converted sound, and how much to keep behind it. */
const AHEAD = 4 * 60;
const BEHIND = 45;
/** Each piece starts a little early; the overlap hides the joins. */
const OVERLAP = 0.3;

let loading: Promise<FFmpeg> | null = null;

/** Loads FFmpeg once (from this server, never a third party). */
async function loadFFmpeg(onStatus?: (text: string) => void): Promise<FFmpeg> {
  return (loading ??= (async () => {
    onStatus?.('Downloading the sound converter (32 MB, only the first time)…');
    const [{ FFmpeg }, { default: coreURL }, { default: wasmURL }] = await Promise.all([
      import('@ffmpeg/ffmpeg'),
      import('@ffmpeg/core?url'),
      import('@ffmpeg/core/wasm?url'),
    ]);
    const ffmpeg = new FFmpeg();
    await ffmpeg.load({ coreURL, wasmURL });
    return ffmpeg;
  })().catch((err) => {
    loading = null;
    throw err;
  }));
}

/** Runs FFmpeg on the file in place (WORKERFS reads it piece by piece, never copying it all). */
async function withFile<T>(ffmpeg: FFmpeg, file: File, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = `/in-${Math.random().toString(36).slice(2)}`;
  await ffmpeg.createDir(dir);
  await ffmpeg.mount('WORKERFS' as never, { files: [file] }, dir);
  try {
    return await fn(`${dir}/${file.name}`);
  } finally {
    await ffmpeg.unmount(dir).catch(() => {});
    await ffmpeg.deleteDir(dir).catch(() => {});
  }
}

/**
 * What sound the file has, if the browser can't play it itself. Returns null
 * when there's no sound at all, or when it's a kind the browser plays anyway.
 */
export async function probeSound(file: File, onStatus?: (text: string) => void): Promise<SoundInfo | null> {
  const ffmpeg = await loadFFmpeg(onStatus);
  onStatus?.('Checking the sound…');
  const lines: string[] = [];
  const onLog = ({ message }: { message: string }) => lines.push(message);
  ffmpeg.on('log', onLog);
  try {
    // With no output FFmpeg only reads the file's header and lists its streams.
    await withFile(ffmpeg, file, (path) => ffmpeg.exec(['-hide_banner', '-i', path]));
  } finally {
    ffmpeg.off('log', onLog);
  }
  // "Stream #0:1(eng): Audio: ac3, 48000 Hz, 5.1(side), fltp, 384 kb/s (default)"
  const audio = lines.map((l) => /Stream #\d+:\d+.*?: Audio: (\w+)[^,]*, \d+ Hz, ([^,]+)/.exec(l)).find(Boolean);
  if (!audio) return null;
  const codec = audio[1].toLowerCase();
  if (PLAYABLE.test(codec)) return null;
  const layout = audio[2].replace(/\(.*\)/, '').trim();
  return { codec, label: `${NAMES[codec] ?? codec.toUpperCase()}${layout && layout !== 'stereo' ? ` ${layout}` : ''}` };
}

/** Where the host hears the sound: volume and mute only for them, and their chosen speaker. */
export type LocalOutput = {
  volume: number;
  muted: boolean;
  setSinkId?: (id: string) => Promise<void>;
};

/** Plays a file's sound, converted on the fly, in step with its video. */
export class SoundFix {
  readonly audio = new Audio();
  /**
   * The sound for viewers. It comes out of Web Audio rather than the <audio>'s own
   * capture, which in Chrome sometimes splits into two tracks, one of them silent.
   */
  readonly track: MediaStreamTrack;
  /** What the host hears; changing it never changes what viewers get. */
  readonly local: LocalOutput;
  private context = new AudioContext();
  private media = new MediaSource();
  private buffer: SourceBuffer | null = null;
  private stopped = false;
  private timer = 0;
  private url: string;
  /** Called with "Getting the sound ready…" while catching up (after a jump), and null once it plays. */
  onWaiting: (waiting: boolean) => void = () => {};

  private constructor(
    private ffmpeg: FFmpeg,
    private file: File,
    private video: HTMLVideoElement,
  ) {
    this.url = URL.createObjectURL(this.media);
    this.audio.src = this.url;
    const ctx = this.context;
    void ctx.resume().catch(() => {});
    const source = ctx.createMediaElementSource(this.audio);
    const toViewers = ctx.createMediaStreamDestination();
    const toHost = ctx.createGain();
    source.connect(toViewers);
    source.connect(toHost).connect(ctx.destination);
    this.track = toViewers.stream.getAudioTracks()[0];
    let volume = 1;
    let muted = false;
    const apply = () => toHost.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.02);
    const sinkable = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    this.local = {
      get volume() {
        return volume;
      },
      set volume(v: number) {
        volume = v;
        apply();
      },
      get muted() {
        return muted;
      },
      set muted(m: boolean) {
        muted = m;
        apply();
      },
      ...(sinkable.setSinkId ? { setSinkId: (id: string) => sinkable.setSinkId!(id) } : {}),
    };
    // In the page (it has no controls, so it's invisible) so it shows up in the browser's tools.
    this.audio.dataset.soundFix = '';
    document.body.append(this.audio);
  }

  static supported() {
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(MIME);
  }

  /** Starts converting; resolves once the first sound is ready to play. */
  static async start(file: File, video: HTMLVideoElement, onStatus?: (text: string) => void) {
    const ffmpeg = await loadFFmpeg(onStatus);
    const fix = new SoundFix(ffmpeg, file, video);
    await new Promise<void>((resolve) => fix.media.addEventListener('sourceopen', () => resolve(), { once: true }));
    fix.buffer = fix.media.addSourceBuffer(MIME);
    fix.buffer.mode = 'segments';
    if (Number.isFinite(video.duration)) fix.media.duration = video.duration;
    onStatus?.('Converting the sound…');
    await fix.convert(video.currentTime, FIRST_CHUNK);
    fix.follow();
    void fix.run();
    return fix;
  }

  stop() {
    this.stopped = true;
    window.clearInterval(this.timer);
    for (const ev of ['play', 'pause', 'seeking', 'seeked', 'ratechange']) this.video.removeEventListener(ev, this.sync);
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.audio.remove();
    URL.revokeObjectURL(this.url);
    this.track.stop();
    void this.context.close().catch(() => {});
  }

  /** End of the converted sound around `t`, or `t` itself if there's none there yet. */
  private aheadOf(t: number) {
    const r = this.buffer?.buffered;
    if (!r) return t;
    for (let i = 0; i < r.length; i++) if (r.start(i) <= t + 0.5 && r.end(i) > t) return r.end(i);
    return t;
  }

  /** Converts [start, start + length) and adds it to what the <audio> can play. */
  private async convert(start: number, length: number) {
    const from = Math.max(0, start - OVERLAP);
    const out = `/out-${Math.round(start * 1000)}.mp4`;
    await withFile(this.ffmpeg, this.file, (path) =>
      this.ffmpeg.exec([
        '-hide_banner', '-loglevel', 'error',
        '-ss', from.toFixed(3), '-i', path, '-t', (length + start - from).toFixed(3),
        '-map', '0:a:0', '-vn', '-sn', '-dn',
        '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000',
        '-f', 'mp4', '-movflags', 'empty_moov+default_base_moof', '-frag_duration', '1000000', out,
      ]),
    );
    const data = (await this.ffmpeg.readFile(out)) as Uint8Array;
    await this.ffmpeg.deleteFile(out).catch(() => {});
    if (this.stopped || !data.length) return;
    await this.append(data, from, start);
  }

  private async append(data: Uint8Array, offset: number, keepFrom: number) {
    const sb = this.buffer!;
    const done = () => new Promise<void>((resolve) => sb.addEventListener('updateend', () => resolve(), { once: true }));
    if (sb.updating) await done();
    sb.timestampOffset = offset;
    // Drop the overlap at the start: the previous piece already covers it.
    sb.appendWindowStart = 0;
    sb.appendWindowEnd = Infinity;
    sb.appendWindowStart = keepFrom;
    try {
      sb.appendBuffer(data as BufferSource);
      await done();
    } catch (err) {
      // The browser keeps only so much sound; make room and try once more.
      if ((err as DOMException).name !== 'QuotaExceededError') throw err;
      await this.evict(true);
      sb.appendBuffer(data as BufferSource);
      await done();
    }
  }

  /** Forgets sound well behind the picture (browsers cap how much they keep). */
  private async evict(hard = false) {
    const sb = this.buffer!;
    const t = this.video.currentTime;
    const ranges: [number, number][] = [];
    for (let i = 0; i < sb.buffered.length; i++) ranges.push([sb.buffered.start(i), sb.buffered.end(i)]);
    for (const [s, e] of ranges) {
      const before: [number, number] = [s, Math.min(e, t - (hard ? 5 : BEHIND))];
      const after: [number, number] = [Math.max(s, t + AHEAD + CHUNK), e];
      for (const [a, b] of [before, after]) {
        if (b - a < 1) continue;
        if (sb.updating) await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
        sb.remove(a, b);
        await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
      }
    }
  }

  /** Keeps converting a little ahead of wherever the picture is. */
  private async run() {
    while (!this.stopped) {
      const t = this.video.currentTime;
      const ready = this.aheadOf(t);
      const end = Number.isFinite(this.video.duration) ? this.video.duration : Infinity;
      if (ready - t >= AHEAD || ready >= end - 0.05) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      try {
        // Right after a jump, a short piece gets sound back quickly.
        await this.convert(ready, ready - t < 2 ? FIRST_CHUNK : CHUNK);
        await this.evict();
      } catch (err) {
        if (this.stopped) return;
        console.warn('Sound conversion failed', err);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private follow() {
    for (const ev of ['play', 'pause', 'seeking', 'seeked', 'ratechange']) this.video.addEventListener(ev, this.sync);
    this.timer = window.setInterval(this.sync, 250);
    this.sync();
  }

  /** Keeps the sound on the picture: jumps when far off, nudges the speed when slightly off. */
  private sync = () => {
    if (this.stopped) return;
    const v = this.video;
    const a = this.audio;
    const t = v.currentTime;
    const hasSound = this.aheadOf(t) - t > 0.2;
    this.onWaiting(!v.paused && !hasSound);
    if (v.paused || v.ended || v.seeking || !hasSound) {
      if (!a.paused) a.pause();
      if (!hasSound || v.seeking) a.currentTime = Math.max(0, t);
      return;
    }
    const drift = a.currentTime - t;
    if (a.paused || Math.abs(drift) > 0.3) {
      a.currentTime = t;
      a.playbackRate = v.playbackRate;
    } else {
      a.playbackRate = Math.abs(drift) < 0.03 ? v.playbackRate : v.playbackRate * (drift > 0 ? 0.97 : 1.03);
    }
    if (a.paused) void a.play().catch(() => {});
  };
}
