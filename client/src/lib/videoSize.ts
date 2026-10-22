// The size of the picture in each stream, as its <video> decodes it: a remote
// camera's track doesn't say (getSettings() has no width or height), and
// Android's floating call window takes the picture's shape (nativeApp.ts).

type Size = { w: number; h: number };
const sizes = new WeakMap<MediaStream, Size>();
const listeners = new Set<() => void>();

/** From a <video> showing the stream (components/CallControls.tsx), whenever its picture changes size. */
export function noteVideoSize(stream: MediaStream, w: number, h: number) {
  if (!w || !h) return;
  const was = sizes.get(stream);
  if (was && was.w === w && was.h === h) return;
  sizes.set(stream, { w, h });
  for (const fn of listeners) fn();
}

export const videoSize = (stream: MediaStream): Size | undefined => sizes.get(stream);

export function onVideoSize(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
