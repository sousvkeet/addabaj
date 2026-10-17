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
