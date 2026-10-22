import { io, type Socket } from 'socket.io-client';

export const socket: Socket = io({ autoConnect: false, withCredentials: true, transports: ['websocket', 'polling'] });

type Ack<T> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Sends and waits for the server's answer. `waitOnline`: with no connection,
 * wait this long for it to come back instead of failing at once (a message
 * written offline goes when the line is back, like other messengers; it was
 * never sent, so it can't arrive twice).
 */
export function emitAck<T = object>(event: string, payload: unknown, timeout = 10_000, { waitOnline = 0 } = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const send = () =>
      socket.timeout(timeout).emit(event, payload, (err: Error | null, res: Ack<T>) => {
        if (err) reject(new Error("The server didn't respond. Check your connection."));
        else if (!res.ok) reject(new Error(res.error));
        else resolve(res);
      });
    if (socket.connected) return send();
    if (!waitOnline) return reject(new Error("You're offline. Reconnecting…"));
    const gaveUp = window.setTimeout(() => {
      socket.off('connect', onConnect);
      reject(new Error("Not sent: there's still no connection."));
    }, waitOnline);
    const onConnect = () => {
      window.clearTimeout(gaveUp);
      send();
    };
    socket.once('connect', onConnect);
  });
}

/** Resolves once connected (at once when already), or fails after `ms` without a connection. */
export function whenOnline(ms: number): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const gaveUp = window.setTimeout(() => {
      socket.off('connect', onConnect);
      reject(new Error("Not sent: there's still no connection."));
    }, ms);
    const onConnect = () => {
      window.clearTimeout(gaveUp);
      resolve();
    };
    socket.once('connect', onConnect);
  });
}
