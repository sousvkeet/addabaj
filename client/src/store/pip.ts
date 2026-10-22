import { create } from 'zustand';

/**
 * The Android app is in Android's picture-in-picture: the whole page is the
 * small floating window over other apps, showing just the call's video
 * (components/CallPip.tsx). App 1.10.0 on.
 */
export const usePip = create<{ native: boolean }>()(() => ({ native: false }));
