export interface SlcmCredentials {
  username: string;
  password: string;
}

export interface SlcmLoginOptions extends SlcmCredentials {
  signal?: AbortSignal;
}

export interface SlcmEndpoints {
  authorization: string;
  token: string;
  user: string;
}

export interface SlcmClientOptions {
  /** Custom fetch implementation, primarily useful for tests and controlled egress. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  refreshMarginMs?: number;
  userAgent?: string;
  clientId?: string;
  redirectUri?: string;
  endpoints?: Partial<SlcmEndpoints>;
  onEvent?: (event: SlcmEvent) => void;
}

export type SlcmEvent =
  | { type: "login:start" }
  | { type: "login:success"; expiresAt: number }
  | { type: "token:refresh" }
  | { type: "token:refreshed"; expiresAt: number }
  | {
      type: "request:retry";
      operation: string;
      attempt: number;
      delayMs: number;
      reason: string;
    };

export interface SlcmTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  tokenType: string;
  expiresIn: number;
  obtainedAt: number;
  expiresAt: number;
}

export type SlcmUserInfo = Record<string, unknown> & {
  org_code?: unknown;
  username?: unknown;
  full_name?: unknown;
  role?: unknown;
};

export interface SlcmSessionSnapshot {
  tokens: SlcmTokens;
  xAppToken: string;
  user: SlcmUserInfo | null;
  orgCode: string | null;
  role: string | null;
}
