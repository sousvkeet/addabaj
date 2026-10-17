export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Options = { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown };

export async function api<T = unknown>(path: string, { method = 'GET', body }: Options = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can't reach Adda Khana. Check your connection and try again.");
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'Something went wrong. Try again.');
  return data as T;
}

export const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : 'Something went wrong. Try again.';
