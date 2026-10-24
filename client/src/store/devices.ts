import { create } from 'zustand';

// Which microphone, speaker and camera to use. '' means "follow the system
// default". Choices are remembered per browser, by ID and by name: browsers
// rotate device IDs (per session, or when permission was "this time only"),
// so a stale ID is matched back to the same device by its name.

export type DeviceKind = 'audioinput' | 'audiooutput' | 'videoinput';
export type Device = { deviceId: string; label: string; kind: DeviceKind };
type Choice = { audioinput: string; audiooutput: string; videoinput: string };
type Names = Partial<Record<DeviceKind, string>>;

const KEY = 'adda-devices';
const KINDS = ['audioinput', 'audiooutput', 'videoinput'] as const;

function load(): { choice: Choice; names: Names; noiseCancel: boolean } {
  const choice = { audioinput: '', audiooutput: '', videoinput: '' };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    for (const k of KINDS) if (typeof saved[k] === 'string') choice[k] = saved[k];
    return { choice, names: saved.names ?? {}, noiseCancel: saved.noiseCancel !== false };
  } catch {
    return { choice, names: {}, noiseCancel: true };
  }
}

const saved = load();
let noiseCancel = saved.noiseCancel;

function persist(choice: Choice, names: Names) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...choice, names, noiseCancel }));
  } catch {
    /* storage unavailable */
  }
}

/** Browsers that can send audio to a chosen speaker (Chrome, Edge, Firefox). */
export const canPickSpeaker = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

type Listener = (kind: DeviceKind) => void;
const listeners = new Set<Listener>();
/** Call/voice stores subscribe so a new choice applies mid-call. */
export const onDeviceChoice = (fn: Listener) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

type DevicesState = {
  choice: Choice;
  /** Name of each chosen device, to find it again when its ID changes. */
  names: Names;
  devices: Device[];
  /** What "System default" currently means, when the browser says (Chrome, Edge). */
  defaults: Partial<Record<DeviceKind, string>>;
  /** False until the browser reveals device names (needs mic/camera permission once). */
  labelled: boolean;
  /** Noise cancellation of the microphone in calls and room voice (on unless turned off). */
  noiseCancel: boolean;
  refresh: () => Promise<void>;
  choose: (kind: DeviceKind, deviceId: string) => void;
  setNoiseCancel: (on: boolean) => void;
};

export const useDevices = create<DevicesState>()((set, get) => ({
  choice: saved.choice,
  names: saved.names,
  devices: [],
  defaults: {},
  labelled: false,
  noiseCancel,

  refresh: async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices();
    // Chrome adds a "default" pseudo-device ("Default - Headset Mic"). Our own
    // "System default" option stands in for it, labelled with what it points to.
    const defaults: Partial<Record<DeviceKind, string>> = {};
    for (const d of all) {
      if (d.deviceId === 'default' && d.label) defaults[d.kind as DeviceKind] = d.label.replace(/^Default\s*-\s*/i, '');
    }
    const devices = all
      .filter((d) => d.deviceId && d.deviceId !== 'default')
      .map((d) => ({ deviceId: d.deviceId, label: d.label, kind: d.kind as DeviceKind }));
    set({ devices, defaults, labelled: devices.some((d) => d.label) });

    const { choice, names } = get();
    for (const kind of KINDS) {
      const id = choice[kind];
      const ofKind = devices.filter((d) => d.kind === kind);
      if (!id || ofKind.some((d) => d.deviceId === id)) continue;
      // Without names (no permission yet) the list can't be trusted; keep the choice.
      if (!ofKind.some((d) => d.label)) continue;
      const same = names[kind] ? ofKind.find((d) => d.label === names[kind]) : undefined;
      if (same) {
        // Same device under a new ID: update quietly, nothing needs switching.
        const next = { ...get().choice, [kind]: same.deviceId };
        persist(next, get().names);
        set({ choice: next });
      } else {
        // Really gone (unplugged): fall back to the default.
        get().choose(kind, '');
      }
    }
  },

  choose: (kind, deviceId) => {
    const choice = { ...get().choice, [kind]: deviceId };
    const label = get().devices.find((d) => d.kind === kind && d.deviceId === deviceId)?.label;
    const names = { ...get().names, [kind]: deviceId ? label ?? get().names[kind] : undefined };
    persist(choice, names);
    set({ choice, names });
    listeners.forEach((fn) => fn(kind));
  },

  setNoiseCancel: (on) => {
    noiseCancel = on;
    persist(get().choice, get().names);
    set({ noiseCancel: on });
    // A call or room voice going on takes the microphone again, with or without it.
    listeners.forEach((fn) => fn('audioinput'));
  },
}));

export const chosen = (kind: DeviceKind) => useDevices.getState().choice[kind];


if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener?.('devicechange', () => void useDevices.getState().refresh());
}
