// Shared handle on the Socket.IO server plus in-memory presence, so REST
// routes can push realtime events after they change data.
let io = null;

export const setIO = (server) => { io = server; };
export const getIO = () => io;

export const userChannel = (userId) => `user:${userId}`;
export const roomChannel = (roomId) => `room:${roomId}`;

const sockets = new Map(); // userId -> Set<socketId>

export const presence = {
  /** Returns true when this is the user's first open connection. */
  add(userId, socketId) {
    let set = sockets.get(userId);
    const first = !set;
    if (!set) sockets.set(userId, (set = new Set()));
    set.add(socketId);
    return first;
  },
  /** Returns true when the user has no connections left. */
  remove(userId, socketId) {
    const set = sockets.get(userId);
    if (!set) return false;
    set.delete(socketId);
    if (set.size === 0) {
      sockets.delete(userId);
      return true;
    }
    return false;
  },
  isOnline: (userId) => sockets.has(userId),
  list: () => [...sockets.keys()],
};
