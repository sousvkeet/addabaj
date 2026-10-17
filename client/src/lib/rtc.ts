import { api } from './api';
import { audioContext } from './sounds';

type IceConfig = { iceServers: RTCIceServer[]; iceTransportPolicy: RTCIceTransportPolicy; fetchedAt: number };

const FALLBACK: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];
// TURN credentials are short-lived, so refetch them now and then in long sessions.
const MAX_AGE_MS = 60 * 60 * 1000;
let ice: IceConfig | null = null;

export async function loadIceServers() {
  if (ice && Date.now() - ice.fetchedAt < MAX_AGE_MS) return ice;
  try {
    const cfg = await api<{ iceServers: RTCIceServer[]; iceTransportPolicy?: RTCIceTransportPolicy }>('/config');
    ice = { iceServers: cfg.iceServers, iceTransportPolicy: cfg.iceTransportPolicy ?? 'all', fetchedAt: Date.now() };
  } catch {
    // Keep what we have; a fetchedAt of 0 means "try again next time".
    ice ??= { iceServers: FALLBACK, iceTransportPolicy: 'all', fetchedAt: 0 };
  }
  return ice;
}

/** Call after loadIceServers() has resolved so the TURN config is in place. */
export function createPeer() {
  return new RTCPeerConnection({
    iceServers: ice?.iceServers ?? FALLBACK,
    iceTransportPolicy: ice?.iceTransportPolicy ?? 'all',
  });
}

/** Ask for the microphone with clear, fixable error messages. */
export async function getMicrophone(): Promise<MediaStream> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Voice needs a secure connection. Open Adda Khana over https:// or on localhost.');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new Error('Microphone access is blocked. Allow it from the lock icon in the address bar, then try again.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new Error('No microphone found. Plug one in and try again.');
    }
    if (name === 'NotReadableError') {
      throw new Error('Your microphone is being used by another app. Close it and try again.');
    }
    throw new Error("Couldn't start your microphone.");
  }
}

export const stopStream = (stream: MediaStream | null | undefined) =>
  stream?.getTracks().forEach((t) => t.stop());

/**
 * Watches a stream's loudness and reports when someone starts or stops
 * speaking. A short hold keeps the ring from flickering between words.
 */
export function watchSpeaking(stream: MediaStream, onChange: (speaking: boolean) => void) {
  let ctx: AudioContext;
  try {
    ctx = audioContext();
  } catch {
    return () => {};
  }
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  let speaking = false;
  let quietSince = 0;
  const id = window.setInterval(() => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    const rms = Math.sqrt(sum / data.length);
    const now = performance.now();
    if (rms > 0.035) {
      quietSince = 0;
      if (!speaking) onChange((speaking = true));
    } else if (speaking) {
      if (!quietSince) quietSince = now;
      else if (now - quietSince > 350) onChange((speaking = false));
    }
  }, 90);
  return () => {
    window.clearInterval(id);
    source.disconnect();
    if (speaking) onChange(false);
  };
}

/** Holds ICE candidates that arrive before the remote description is set. */
export class CandidateQueue {
  private queue: RTCIceCandidateInit[] = [];
  constructor(private pc: RTCPeerConnection) {}
  async add(candidate: RTCIceCandidateInit) {
    if (this.pc.remoteDescription) await this.pc.addIceCandidate(candidate).catch(() => {});
    else this.queue.push(candidate);
  }
  async flush() {
    const items = this.queue.splice(0);
    for (const c of items) await this.pc.addIceCandidate(c).catch(() => {});
  }
}
