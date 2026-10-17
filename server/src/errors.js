export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

export const badRequest = (msg) => new AppError(400, msg);
export const forbidden = (msg = "You don't have permission to do that.") => new AppError(403, msg);
export const notFound = (msg = 'Not found.') => new AppError(404, msg);
export const conflict = (msg) => new AppError(409, msg);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

export function assertUuid(v, what = 'id') {
  if (!isUuid(v)) throw notFound(`That ${what} doesn't exist.`);
  return v;
}
