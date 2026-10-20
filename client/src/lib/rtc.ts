import { api } from './api';
import { audioContext } from './sounds';
import { chosen, useDevices } from '../store/devices';

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

const AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const VIDEO: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };

function requireMediaDevices() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Calls need a secure connection. Open Adda Khana over https:// or on localhost.');
  }
}

function friendlyError(err: unknown, device: 'microphone' | 'camera'): Error {
  const name = (err as DOMException)?.name;
  const Device = device === 'microphone' ? 'Microphone' : 'Camera';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new Error(`${Device} access is blocked. Allow it from the lock icon in the address bar, then try again.`);
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new Error(`No ${device} found. Plug one in and try again.`);
  if (name === 'NotReadableError') return new Error(`Your ${device} is being used by another app. Close it and try again.`);
  return new Error(`Couldn't start your ${device}.`);
}

/**
 * Opens the chosen device, or the system default when none is chosen. A saved
 * ID can go stale (browsers rotate them), so on failure this opens the default
 * to unlock device names, finds the chosen device again by name, and switches
 * to it. Only a device that is really gone falls back to the default.
 */
async function open(kind: 'audioinput' | 'videoinput', base: MediaTrackConstraints): Promise<MediaStream> {
  requireMediaDevices();
  const devices = useDevices.getState();
  await devices.refresh().catch(() => {});
  const id = chosen(kind);
  const constraints = (deviceId?: string) =>
    kind === 'audioinput'
      ? { audio: { ...base, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, video: false }
      : { video: { ...base, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, audio: false };
  const gum = (deviceId?: string) => navigator.mediaDevices.getUserMedia(constraints(deviceId));
  try {
    const stream = await gum(id || undefined);
    void devices.refresh(); // device names become available after permission
    return stream;
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (!id || (name !== 'NotFoundError' && name !== 'OverconstrainedError')) {
      throw friendlyError(err, kind === 'audioinput' ? 'microphone' : 'camera');
    }
    let fallback: MediaStream;
    try {
      fallback = await gum();
    } catch (err2) {
      throw friendlyError(err2, kind === 'audioinput' ? 'microphone' : 'camera');
    }
    await devices.refresh().catch(() => {}); // re-matches the choice by name
    const found = chosen(kind);
    if (found && found !== id) {
      try {
        const exact = await gum(found);
        stopStream(fallback);
        return exact;
      } catch {
        /* keep the default */
      }
    }
    if (chosen(kind) === id) useDevices.getState().choose(kind, '');
    return fallback;
  }
}

/** Ask for the microphone with clear, fixable error messages. */
export const getMicrophone = () => open('audioinput', AUDIO);

/** Ask for the camera with clear, fixable error messages. */
export const getCamera = () => open('videoinput', VIDEO);

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

/** Reports input loudness (0–1) about 12 times a second, for a level meter. */
export function watchLevel(stream: MediaStream, onLevel: (level: number) => void) {
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
  const id = window.setInterval(() => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += ((v - 128) / 128) ** 2;
    onLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
  }, 80);
  return () => {
    window.clearInterval(id);
    source.disconnect();
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
