export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

type ErrorLike = { code?: unknown; status?: unknown; response?: { status?: unknown }; message?: unknown };

export function statusOf(err: unknown): number | undefined {
  if (err instanceof HttpError) return err.status;
  const e = (err ?? {}) as ErrorLike;
  for (const candidate of [e.response?.status, e.status, e.code]) {
    if (typeof candidate === "number") return candidate;
    if (typeof candidate === "string" && /^\d{3}$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}

export function isRetryableError(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined) return status === 429 || status >= 500;
  const e = (err ?? {}) as ErrorLike;
  // fetch 네트워크 오류는 TypeError, Node 소켓 오류는 code가 "ECONNRESET" 같은 문자열
  return err instanceof TypeError || typeof e.code === "string";
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const e = (err ?? {}) as ErrorLike;
  return typeof e.message === "string" ? e.message : String(err);
}

export type RetryOptions = {
  retries?: number;
  baseDelayMs?: number;
  isRetryable?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 1000;
  const isRetryable = opts.isRetryable ?? isRetryableError;
  const sleep = opts.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      await sleep(base * 2 ** attempt);
      attempt++;
    }
  }
}
