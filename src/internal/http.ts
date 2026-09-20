import { SlcmNetworkError } from "../errors.js";
import type { SlcmEvent } from "../types.js";

export interface RequestContext {
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
  onEvent?: (event: SlcmEvent) => void;
}

export async function request(
  context: RequestContext,
  operation: string,
  input: string | URL,
  init: RequestInit & { signal?: AbortSignal },
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const timeout = AbortSignal.timeout(context.timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;

    try {
      const response = await context.fetch(input, { ...init, signal });
      if (!isTransientStatus(response.status) || attempt >= context.retries) {
        return response;
      }

      const delayMs = context.retryDelayMs * 2 ** attempt;
      context.onEvent?.({
        type: "request:retry",
        operation,
        attempt: attempt + 1,
        delayMs,
        reason: `HTTP ${response.status}`,
      });
      await delay(delayMs, init.signal);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      if (attempt >= context.retries) {
        throw new SlcmNetworkError(
          `${operation} failed after ${attempt + 1} attempt(s).`,
          { cause: error },
        );
      }

      const delayMs = context.retryDelayMs * 2 ** attempt;
      context.onEvent?.({
        type: "request:retry",
        operation,
        attempt: attempt + 1,
        delayMs,
        reason: error instanceof Error ? error.name : "network error",
      });
      await delay(delayMs, init.signal);
    }
  }
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timer.unref?.();

    if (!signal) return;
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
