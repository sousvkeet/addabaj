import { getMicrophone, stopStream, watchLevel } from './rtc';
import type { PreparedFile } from './types';

const MAX_SECONDS = 5 * 60;
const BARS = 48;

/** The best recording format this browser offers (Opus in WebM/Ogg, else AAC in MP4 on Safari). */
function pickType() {
  for (const t of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

export const canRecordVoice = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

/**
 * Records a voice message from the chosen microphone, keeping a loudness
 * trace for the waveform. Stops by itself at five minutes.
 */
export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private levels: number[] = [];
  private stopLevels: () => void = () => {};
  private startedAt = 0;
  onLevel: (level: number) => void = () => {};
  onLimit: () => void = () => {};

  async start() {
    this.stream = await getMicrophone();
    const mimeType = pickType();
    this.recorder = new MediaRecorder(this.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start(250);
    this.startedAt = performance.now();
    this.stopLevels = watchLevel(this.stream, (level) => {
      this.levels.push(level);
      this.onLevel(level);
      if (this.seconds() >= MAX_SECONDS) this.onLimit();
    });
  }

  seconds() {
    return this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  /** Finishes and returns the recording, ready to send. */
  async stop(): Promise<PreparedFile> {
    const recorder = this.recorder!;
    const duration = this.seconds();
    const stopped = new Promise((r) => (recorder.onstop = r));
    recorder.stop();
    await stopped;
    this.release();
    const type = recorder.mimeType || 'audio/webm';
    const blob = new Blob(this.chunks, { type });
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    const stamp = new Date().toTimeString().slice(0, 5).replace(':', '.');
    return {
      blob,
      meta: { kind: 'voice', name: `Voice message ${stamp}.${ext}`, mime: type, duration, waveform: waveform(this.levels) },
      previewUrl: URL.createObjectURL(blob),
    };
  }

  cancel() {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.release();
  }

  private release() {
    this.stopLevels();
    stopStream(this.stream);
    this.stream = null;
  }
}

/** Squeezes the loudness trace into a fixed number of bars (0–100). */
function waveform(levels: number[]) {
  if (!levels.length) return new Array(BARS).fill(8);
  const out: number[] = [];
  for (let i = 0; i < BARS; i++) {
    const from = Math.floor((i * levels.length) / BARS);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / BARS));
    const slice = levels.slice(from, to);
    out.push(Math.max(...slice));
  }
  const peak = Math.max(...out, 0.05);
  return out.map((v) => Math.max(8, Math.round((v / peak) * 100)));
}
