// Wraps a socket handler so it always answers its ack with { ok, ...data } or
// { ok: false, error } and never crashes the connection.
export function handle(fn) {
  return async (payload, ack) => {
    try {
      const result = await fn(payload && typeof payload === 'object' ? payload : {});
      if (typeof ack === 'function') ack({ ok: true, ...(result ?? {}) });
    } catch (err) {
      if (!err.expose) console.error(err);
      if (typeof ack === 'function') ack({ ok: false, error: err.expose ? err.message : 'Something went wrong. Try again.' });
    }
  };
}

/**
 * Makes every handler on a socket safe to call with anything. Socket.IO
 * doesn't catch errors thrown by event handlers, so one bad payload (say
 * `null` where an object is expected) would otherwise crash the whole server.
 * Payloads that aren't plain objects become {}, and a handler that throws is
 * logged instead.
 */
export function guardSocket(socket) {
  const on = socket.on.bind(socket);
  socket.on = (event, listener) =>
    on(event, (...args) => {
      if (!['disconnect', 'disconnecting', 'error'].includes(event)) {
        const first = args[0];
        if (typeof first !== 'function' && (first === null || typeof first !== 'object' || Array.isArray(first))) args[0] = {};
      }
      try {
        const result = listener(...args);
        if (result && typeof result.catch === 'function') result.catch((err) => console.error(`Socket event "${event}" failed`, err));
      } catch (err) {
        console.error(`Socket event "${event}" failed`, err);
      }
    });
  return socket;
}

/** Allows `limit` actions per `windowMs` per key (a person), for spam-prone events. */
export function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= limit) return false;
    list.push(now);
    hits.set(key, list);
    if (hits.size > 10_000) hits.clear();
    return true;
  };
}
