import { create } from 'zustand';
import { nativeAskPermission, nativePermissions, nativePermissionsSeen, type AppPermissions, type PermissionName } from '../lib/native';

type PermissionsState = {
  /** Where the app's permissions stand on this phone (null: a browser, or an app from before 1.10.0). */
  state: AppPermissions | null;
  /** Android's prompt or the phone's settings is open for one; over when the app says how it went. */
  asking: PermissionName | 'all' | null;
  set: (state: AppPermissions) => void;
  ask: (which: PermissionName | 'all') => void;
  /** The first-run screen was seen: it doesn't open by itself again. */
  markSeen: () => void;
};

export const usePermissions = create<PermissionsState>()((set, get) => ({
  // Asking now also tells the app that the page shows its own screen for them.
  state: nativePermissions(),
  asking: null,
  set: (state) => set({ state, asking: null }),
  ask: (which) => {
    if (!get().state) return;
    set({ asking: which });
    nativeAskPermission(which);
  },
  markSeen: () => {
    nativePermissionsSeen();
    set((s) => (s.state ? { state: { ...s.state, seen: true } } : s));
  },
}));

/** The permissions this phone has, in the order they're asked for. */
export const ORDER: PermissionName[] = ['notifications', 'microphone', 'camera', 'fullScreen', 'battery'];

/** Those not allowed yet (and which this Android version has). */
export const missing = (state: AppPermissions | null) => (state ? ORDER.filter((p) => state[p] && state[p] !== 'granted') : []);
