import type {
  SlcmActivePeriod,
  SlcmActivePeriodOptions,
  SlcmClass,
  SlcmClassTableOptions,
  SlcmPeriod,
  SlcmSchedule,
  SlcmScheduleOptions,
  SlcmSessionSnapshot,
  SlcmTokens,
  SlcmUserInfo,
} from "./types.js";
import {
  parseClassTableResponse,
  parsePeriodsResponse,
  resolveActivePeriod,
} from "./internal/schedule-protocol.js";

/** @internal */
export interface SessionBundle {
  tokens: SlcmTokens;
  xAppToken: string;
  user: SlcmUserInfo | null;
  activePeriod: SlcmActivePeriod | null;
}

interface SessionRuntime {
  refresh(
    current: SlcmTokens,
    signal?: AbortSignal,
  ): Promise<SessionBundle>;
  refreshMarginMs: number;
  getJson(
    bundle: SessionBundle,
    endpoint: "periods" | "classTable",
    query: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<{ bundle: SessionBundle; value: unknown }>;
}

export class SlcmSession {
  #bundle: SessionBundle;
  readonly #runtime: SessionRuntime;

  private constructor(bundle: SessionBundle, runtime: SessionRuntime) {
    this.#bundle = bundle;
    this.#runtime = runtime;
  }

  /** @internal Sessions are created by SlcmClient.login(). */
  static create(bundle: SessionBundle, runtime: SessionRuntime): SlcmSession {
    return new SlcmSession(bundle, runtime);
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

  get activePeriod(): Readonly<SlcmActivePeriod> | null {
    return this.#bundle.activePeriod ? { ...this.#bundle.activePeriod } : null;
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
      activePeriod: this.activePeriod ? { ...this.activePeriod } : null,
    };
  }

  async getPeriods(signal?: AbortSignal): Promise<SlcmPeriod[]> {
    const value = await this.#getJson("periods", {}, signal);
    return parsePeriodsResponse(value);
  }

  async getActivePeriod(
    options: SlcmActivePeriodOptions = {},
  ): Promise<SlcmPeriod> {
    const periods = await this.getPeriods(options.signal);
    return resolveActivePeriod(periods, this.#bundle.activePeriod);
  }

  async getClassTable(options: SlcmClassTableOptions): Promise<SlcmClass[]> {
    const period =
      options.period ??
      (await this.getActivePeriod(
        options.signal ? { signal: options.signal } : {},
      ));
    const value = await this.#getJson(
      "classTable",
      {
        type: options.type,
        year: String(period.year),
        term: String(period.term),
        lang: options.language ?? "id",
      },
      options.signal,
    );
    return parseClassTableResponse(value, options.type);
  }

  async getSchedule(options: SlcmScheduleOptions = {}): Promise<SlcmSchedule> {
    const period =
      options.period ??
      (await this.getActivePeriod(
        options.signal ? { signal: options.signal } : {},
      ));
    const shared = {
      period,
      ...(options.language ? { language: options.language } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const [internal, group, external] = await Promise.all([
      this.getClassTable({ ...shared, type: "internal" }),
      this.getClassTable({ ...shared, type: "group" }),
      this.getClassTable({ ...shared, type: "external" }),
    ]);

    return {
      period,
      classes: [...internal, ...group, ...external],
      byType: { internal, group, external },
    };
  }

  async #getJson(
    endpoint: "periods" | "classTable",
    query: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (
      Date.now() >=
      this.#bundle.tokens.expiresAt - this.#runtime.refreshMarginMs
    ) {
      await this.refresh(signal);
    }
    const result = await this.#runtime.getJson(
      this.#bundle,
      endpoint,
      query,
      signal,
    );
    this.#bundle = result.bundle;
    return result.value;
  }
}

function stringMetadata(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
