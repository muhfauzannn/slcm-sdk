import type {
  SlcmSessionSnapshot,
  SlcmTokens,
  SlcmUserInfo,
} from "./types.js";

interface SessionBundle {
  tokens: SlcmTokens;
  xAppToken: string;
  user: SlcmUserInfo | null;
}

interface SessionRuntime {
  refresh(
    current: SlcmTokens,
    signal?: AbortSignal,
  ): Promise<SessionBundle>;
  refreshMarginMs: number;
}

export class SlcmSession {
  #bundle: SessionBundle;
  readonly #runtime: SessionRuntime;

  /** @internal Sessions are created by SlcmClient.login(). */
  constructor(bundle: SessionBundle, runtime: SessionRuntime) {
    this.#bundle = bundle;
    this.#runtime = runtime;
  }

  get tokens(): Readonly<SlcmTokens> {
    return { ...this.#bundle.tokens };
  }

  get xAppToken(): string {
    return this.#bundle.xAppToken;
  }

  get user(): Readonly<SlcmUserInfo> | null {
    return this.#bundle.user ? { ...this.#bundle.user } : null;
  }

  get orgCode(): string | null {
    return stringMetadata(this.#bundle.user?.org_code);
  }

  get role(): string | null {
    return stringMetadata(this.#bundle.user?.role);
  }

  get isExpired(): boolean {
    return Date.now() >= this.#bundle.tokens.expiresAt;
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    this.#bundle = await this.#runtime.refresh(this.#bundle.tokens, signal);
  }

  /**
   * Returns the two headers required by authenticated SLCM API endpoints.
   * Refreshes the access token first when it is close to expiry.
   */
  async getAuthHeaders(signal?: AbortSignal): Promise<Record<string, string>> {
    if (
      Date.now() >=
      this.#bundle.tokens.expiresAt - this.#runtime.refreshMarginMs
    ) {
      await this.refresh(signal);
    }

    return {
      Authorization: `${this.#bundle.tokens.tokenType} ${this.#bundle.tokens.accessToken}`,
      "x-app-token": this.#bundle.xAppToken,
    };
  }

  snapshot(): SlcmSessionSnapshot {
    return {
      tokens: { ...this.#bundle.tokens },
      xAppToken: this.#bundle.xAppToken,
      user: this.#bundle.user ? { ...this.#bundle.user } : null,
      orgCode: this.orgCode,
      role: this.role,
    };
  }
}

function stringMetadata(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
