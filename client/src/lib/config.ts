import { api } from './api';

type Limits = { uploadMaxBytes: number; liveViewers: number };
const DEFAULTS: Limits = { uploadMaxBytes: 25 * 1024 * 1024, liveViewers: 10 };
let limits: Promise<Limits> | null = null;

/** Server limits (largest upload, …), fetched once. */
export function getLimits(): Promise<Limits> {
  return (limits ??= api<{ limits: Partial<Limits> }>('/config')
    .then((c) => ({ ...DEFAULTS, ...c.limits }))
    .catch(() => {
      limits = null;
      return DEFAULTS;
    }));
}
