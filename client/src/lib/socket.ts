import { io, type Socket } from 'socket.io-client';

export const socket: Socket = io({ autoConnect: false, withCredentials: true, transports: ['websocket', 'polling'] });

type Ack<T> = ({ ok: true } & T) | { ok: false; error: string };

export function emitAck<T = object>(event: string, payload: unknown, timeout = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!socket.connected) {
      reject(new Error("You're offline. Reconnecting…"));
      return;
    }
    socket.timeout(timeout).emit(event, payload, (err: Error | null, res: Ack<T>) => {
      if (err) reject(new Error("The server didn't respond. Check your connection."));
      else if (!res.ok) reject(new Error(res.error));
      else resolve(res);
    });
  });
}
