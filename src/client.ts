import {
  DEFAULT_REFRESH_MARGIN_MS,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  SLCM_CLIENT_ID,
  SLCM_ENDPOINTS,
  SLCM_REDIRECT_URI,
} from "./constants.js";
import {
  SlcmAuthenticationError,
  SlcmInvalidArgumentError,
  SlcmNetworkError,
  SlcmProtocolError,
} from "./errors.js";
import { CookieJar } from "./internal/cookies.js";
import { createPkceAuthorization } from "./internal/crypto.js";
import { request, type RequestContext } from "./internal/http.js";
import {
  authenticationFailure,
  extractLoginFormAction,
  parseInitialTokenResponse,
  parseActivePeriodResponse,
  parseRefreshTokenResponse,
  parseUserSessionResponse,
} from "./internal/protocol.js";
import { SlcmSession, type SessionBundle } from "./session.js";
import type {
  SlcmActivePeriod,
  SlcmClientOptions,
  SlcmEndpoints,
  SlcmLoginOptions,
  SlcmTokens,
  SlcmUserInfo,
} from "./types.js";

interface AuthenticatedBundle {
  tokens: SlcmTokens;
  xAppToken: string;
  user: SlcmUserInfo | null;
  activePeriod: SlcmActivePeriod | null;
}

interface ResolvedOptions {
  request: RequestContext;
  refreshMarginMs: number;
  userAgent: string;
  clientId: string;
  redirectUri: string;
  endpoints: SlcmEndpoints;
}

export class SlcmClient {
  readonly #options: ResolvedOptions;

  constructor(options: SlcmClientOptions = {}) {
    this.#options = resolveOptions(options);
  }

  async login(options: SlcmLoginOptions): Promise<SlcmSession> {
    validateCredentials(options.username, options.password);
    this.#options.request.onEvent?.({ type: "login:start" });

    const bundle = await this.#login(options);
    this.#options.request.onEvent?.({
      type: "login:success",
      expiresAt: bundle.tokens.expiresAt,
    });

    return SlcmSession.create(bundle, {
      refreshMarginMs: this.#options.refreshMarginMs,
      refresh: async (tokens, signal) => this.#refresh(tokens, signal),
      getJson: async (current, endpoint, query, signal) =>
        this.#getJson(current, endpoint, query, signal),
    });
  }

  async #getJson(
    current: SessionBundle,
    endpoint: "periods" | "classTable" | "myClasses",
    query: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<{ bundle: AuthenticatedBundle; value: unknown }> {
    const url = new URL(this.#options.endpoints[endpoint]);
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, value);
    }

    const send = async (bundle: SessionBundle): Promise<Response> =>
      request(this.#options.request, `GET ${url.pathname}`, url, {
        redirect: "manual",
        headers: {
          Authorization: `${bundle.tokens.tokenType} ${bundle.tokens.accessToken}`,
          "x-app-token": bundle.xAppToken,
          "user-agent": this.#options.userAgent,
        },
        ...(signal ? { signal } : {}),
      });

    let bundle: AuthenticatedBundle = current;
    let response = await send(bundle);
    if (response.status === 401 || response.status === 403) {
      bundle = await this.#refresh(bundle.tokens, signal);
      response = await send(bundle);
    }
    if (!response.ok) throw responseError(`GET ${url.pathname}`, response);

    return {
      bundle,
      value: await readJson(response, url.pathname),
    };
  }

  async #login(options: SlcmLoginOptions): Promise<AuthenticatedBundle> {
    const pkce = createPkceAuthorization();
    const authorizationUrl = new URL(this.#options.endpoints.authorization);
    authorizationUrl.search = new URLSearchParams({
      client_id: this.#options.clientId,
      redirect_uri: this.#options.redirectUri,
      state: pkce.state,
      response_mode: "fragment",
      response_type: "code",
      scope: "openid",
      nonce: pkce.nonce,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: "S256",
    }).toString();

    const jar = new CookieJar();
    const loginPage = await request(
      this.#options.request,
      "Load SSO login page",
      authorizationUrl,
      {
        redirect: "follow",
        headers: { "user-agent": this.#options.userAgent },
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    jar.update(loginPage);
    if (!loginPage.ok) {
      throw responseError("Loading the SSO login page", loginPage);
    }

    const formAction = extractLoginFormAction(
      await loginPage.text(),
      loginPage.url || authorizationUrl.toString(),
    );
    if (
      new URL(formAction).origin !==
      new URL(this.#options.endpoints.authorization).origin
    ) {
      throw new SlcmProtocolError(
        "The SSO login form points to an unexpected origin.",
      );
    }
    const credentialResponse = await request(
      this.#options.request,
      "Submit SSO credentials",
      formAction,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: jar.header(),
          "user-agent": this.#options.userAgent,
        },
        body: new URLSearchParams({
          username: options.username,
          password: options.password,
          credentialId: "",
        }),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    jar.update(credentialResponse);

    if (credentialResponse.status !== 302) {
      if (credentialResponse.status === 429 || credentialResponse.status >= 500) {
        throw responseError("Submitting SSO credentials", credentialResponse);
      }
      return authenticationFailure(credentialResponse, [
        options.username,
        options.password,
      ]);
    }

    const location = credentialResponse.headers.get("location");
    if (!location) {
      throw new SlcmProtocolError(
        "The SSO response did not include a redirect location.",
      );
    }

    const redirect = new URL(location, this.#options.redirectUri);
    const expectedRedirect = new URL(this.#options.redirectUri);
    if (
      redirect.origin !== expectedRedirect.origin ||
      redirect.pathname !== expectedRedirect.pathname
    ) {
      throw new SlcmAuthenticationError(
        "The SSO response redirected to an unexpected location.",
      );
    }
    const fragment = new URLSearchParams(redirect.hash.slice(1));
    if (fragment.get("state") !== pkce.state) {
      throw new SlcmAuthenticationError(
        "The SSO state did not match. The login response may be unsafe.",
      );
    }
    const code = fragment.get("code");
    if (!code) {
      throw new SlcmProtocolError(
        "The SSO response did not include an authorization code.",
      );
    }

    const tokens = await this.#exchangeCode(
      code,
      pkce.codeVerifier,
      options.signal,
    );
    return this.#completeAuthentication(tokens, options.signal);
  }

  async #exchangeCode(
    code: string,
    codeVerifier: string,
    signal?: AbortSignal,
  ): Promise<SlcmTokens> {
    const response = await request(
      this.#options.request,
      "Exchange authorization code",
      this.#options.endpoints.token,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": this.#options.userAgent,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: this.#options.redirectUri,
          client_id: this.#options.clientId,
          code_verifier: codeVerifier,
        }),
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) throw responseError("Exchanging the SSO code", response);
    return parseInitialTokenResponse(await readJson(response, "token endpoint"));
  }

  async #refresh(
    current: SlcmTokens,
    signal?: AbortSignal,
  ): Promise<AuthenticatedBundle> {
    this.#options.request.onEvent?.({ type: "token:refresh" });
    const response = await request(
      this.#options.request,
      "Refresh SLCM token",
      this.#options.endpoints.token,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": this.#options.userAgent,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
          client_id: this.#options.clientId,
        }),
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) throw responseError("Refreshing the SLCM token", response);

    const tokens = parseRefreshTokenResponse(
      await readJson(response, "token endpoint"),
      current,
    );
    const bundle = await this.#completeAuthentication(tokens, signal);
    this.#options.request.onEvent?.({
      type: "token:refreshed",
      expiresAt: tokens.expiresAt,
    });
    return bundle;
  }

  async #completeAuthentication(
    tokens: SlcmTokens,
    signal?: AbortSignal,
  ): Promise<AuthenticatedBundle> {
    const response = await request(
      this.#options.request,
      "Load SLCM user session",
      this.#options.endpoints.user,
      {
        redirect: "manual",
        headers: {
          Authorization: `${tokens.tokenType} ${tokens.accessToken}`,
          "user-agent": this.#options.userAgent,
        },
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) throw responseError("Loading the SLCM user session", response);

    const parsed = parseUserSessionResponse(
      await readJson(response, "SLCM /user"),
    );
    const activePeriod = await this.#loadActivePeriod(
      tokens,
      parsed.xAppToken,
      signal,
    );
    return { tokens, ...parsed, activePeriod };
  }

  async #loadActivePeriod(
    tokens: SlcmTokens,
    xAppToken: string,
    signal?: AbortSignal,
  ): Promise<SlcmActivePeriod> {
    const response = await request(
      this.#options.request,
      "Load active SLCM period",
      this.#options.endpoints.activePeriod,
      {
        redirect: "manual",
        headers: {
          Authorization: `${tokens.tokenType} ${tokens.accessToken}`,
          "x-app-token": xAppToken,
          "user-agent": this.#options.userAgent,
        },
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) {
      throw responseError("Loading the active SLCM period", response);
    }
    return parseActivePeriodResponse(
      await readJson(response, "SLCM class/period"),
    );
  }
}

function resolveOptions(options: SlcmClientOptions): ResolvedOptions {
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const retries = nonNegativeInteger(options.retries, DEFAULT_RETRIES, "retries");
  const retryDelayMs = nonNegativeInteger(options.retryDelayMs, 250, "retryDelayMs");
  const refreshMarginMs = nonNegativeInteger(
    options.refreshMarginMs,
    DEFAULT_REFRESH_MARGIN_MS,
    "refreshMarginMs",
  );

  return {
    request: {
      fetch: options.fetch ?? globalThis.fetch,
      timeoutMs,
      retries,
      retryDelayMs,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    },
    refreshMarginMs,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    clientId: options.clientId ?? SLCM_CLIENT_ID,
    redirectUri: options.redirectUri ?? SLCM_REDIRECT_URI,
    endpoints: { ...SLCM_ENDPOINTS, ...options.endpoints },
  };
}

function validateCredentials(username: string, password: string): void {
  if (typeof username !== "string" || username.trim().length === 0) {
    throw new SlcmInvalidArgumentError("username must not be empty.");
  }
  if (typeof password !== "string" || password.length === 0) {
    throw new SlcmInvalidArgumentError("password must not be empty.");
  }
}

function positiveNumber(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new SlcmInvalidArgumentError(`${name} must be a positive number.`);
  }
  return resolved;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new SlcmInvalidArgumentError(`${name} must be a non-negative integer.`);
  }
  return resolved;
}

function responseError(operation: string, response: Response): Error {
  if (response.status === 401 || response.status === 403) {
    return new SlcmAuthenticationError(`${operation} failed (HTTP ${response.status}).`);
  }
  if (response.status === 429 || response.status >= 500) {
    return new SlcmNetworkError(`${operation} failed (HTTP ${response.status}).`);
  }
  return new SlcmProtocolError(`${operation} failed (HTTP ${response.status}).`);
}

async function readJson(response: Response, source: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new SlcmProtocolError(`${source} returned malformed JSON.`, {
      cause: error,
    });
  }
}
