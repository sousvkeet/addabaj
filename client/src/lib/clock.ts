import { socket } from './socket';

// Server time, so everyone computes the same "where should the video be now".
let offset = 0;

export const serverNow = () => Date.now() + offset;

/** Takes a few round trips and keeps the one with the least delay. */
export async function syncClock() {
  let best: { rtt: number; offset: number } | null = null;
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();
    const res = await new Promise<{ now: number } | null>((resolve) =>
      socket.timeout(3000).emit('time:now', {}, (err: Error | null, r: { now: number }) => resolve(err ? null : r)),
    );
    const t1 = Date.now();
    if (!res) continue;
    const sample = { rtt: t1 - t0, offset: res.now - (t0 + t1) / 2 };
    if (!best || sample.rtt < best.rtt) best = sample;
  }
  if (best) offset = best.offset;
}
