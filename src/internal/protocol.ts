import { SlcmAuthenticationError, SlcmProtocolError } from "../errors.js";
import type {
  SlcmActivePeriod,
  SlcmTokens,
  SlcmUserInfo,
} from "../types.js";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
}

export function parseInitialTokenResponse(value: unknown): SlcmTokens {
  const token = parseTokenResponse(value);
  if (!token.refresh_token || !token.id_token) {
    throw new SlcmProtocolError(
      "The token endpoint response is missing refresh_token or id_token.",
    );
  }
  return toTokens(token, token.refresh_token, token.id_token);
}

export function parseRefreshTokenResponse(
  value: unknown,
  previous: SlcmTokens,
): SlcmTokens {
  const token = parseTokenResponse(value);
  return toTokens(
    token,
    token.refresh_token ?? previous.refreshToken,
    token.id_token ?? previous.idToken,
  );
}

function parseTokenResponse(value: unknown): TokenResponse {
  if (!isRecord(value)) {
    throw new SlcmProtocolError("The token endpoint returned invalid JSON.");
  }

  const accessToken = value.access_token;
  const tokenType = value.token_type;
  const expiresIn = value.expires_in;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof tokenType !== "string" ||
    tokenType.length === 0 ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new SlcmProtocolError(
      "The token endpoint response is missing required token fields.",
    );
  }

  const refreshToken = optionalNonEmptyString(value.refresh_token);
  const idToken = optionalNonEmptyString(value.id_token);
  return {
    access_token: accessToken,
    token_type: tokenType,
    expires_in: expiresIn,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    ...(idToken ? { id_token: idToken } : {}),
  };
}

function toTokens(
  response: TokenResponse,
  refreshToken: string,
  idToken: string,
): SlcmTokens {
  const obtainedAt = Date.now();
  return {
    accessToken: response.access_token,
    refreshToken,
    idToken,
    tokenType: response.token_type,
    expiresIn: response.expires_in,
    obtainedAt,
    expiresAt: obtainedAt + response.expires_in * 1_000,
  };
}

export interface ParsedUserSession {
  xAppToken: string;
  user: SlcmUserInfo | null;
  activePeriod: SlcmActivePeriod | null;
}

export function parseUserSessionResponse(value: unknown): ParsedUserSession {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new SlcmProtocolError("SLCM /user returned an invalid response.");
  }
  const token = value.data.userToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new SlcmProtocolError(
      "SLCM /user response does not contain data.userToken.",
    );
  }
  const payload = decodeJwtPayload(token);
  const user = isRecord(payload?.userInfo) ? payload.userInfo : null;
  const activePeriod = parseActivePeriod(
    value.data.activePeriod ??
      value.data.active_period ??
      payload?.activePeriod ??
      payload?.active_period ??
      user?.activePeriod ??
      user?.active_period,
  );
  return { xAppToken: token, user, activePeriod };
}

export function parseActivePeriodResponse(value: unknown): SlcmActivePeriod {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new SlcmProtocolError(
      "SLCM class/period returned an invalid response.",
    );
  }
  const active = parseActivePeriod(value.data[0]);
  if (active === null) {
    throw new SlcmProtocolError(
      "SLCM class/period did not return an active period.",
    );
  }
  return active;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const encodedPayload = token.split(".")[1];
  if (!encodedPayload) return null;

  try {
    const payload: unknown = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function parseActivePeriod(value: unknown): SlcmActivePeriod | null {
  if (typeof value === "string") {
    const match = /^(\d{4})-([1-3])$/.exec(value.trim());
    if (!match?.[1] || !match[2]) return null;
    return {
      year: Number(match[1]),
      term: Number(match[2]),
      period: `${match[1]}-${match[2]}`,
    };
  }
  if (!isRecord(value)) return null;

  const year = value.year;
  const term = value.term;
  const period = value.period;
  if (
    typeof year !== "number" ||
    !Number.isInteger(year) ||
    typeof term !== "number" ||
    !Number.isInteger(term)
  ) {
    return null;
  }
  return {
    year,
    term,
    period:
      typeof period === "string" && period.trim().length > 0
        ? period.trim()
        : `${year}-${term}`,
  };
}

export async function authenticationFailure(
  response: Response,
  secrets: readonly string[],
): Promise<never> {
  const providerMessage = await extractProviderMessage(response, secrets);
  throw new SlcmAuthenticationError(
    providerMessage ?? `SLCM rejected the credentials (HTTP ${response.status}).`,
  );
}

async function extractProviderMessage(
  response: Response,
  secrets: readonly string[],
): Promise<string | null> {
  try {
    const html = await response.text();
    const patterns = [
      /<[^>]+id=["']input-error["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
      /<[^>]+class=["'][^"']*kc-feedback-text[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
      /<[^>]+class=["'][^"']*alert-error[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
    ];
    const raw = patterns
      .map((pattern) => html.match(pattern)?.[1])
      .find((match): match is string => Boolean(match));
    if (!raw) return null;

    let message = decodeHtml(raw.replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    for (const secret of secrets) {
      if (secret.length > 0) message = message.split(secret).join("[redacted]");
    }
    return message;
  } catch {
    return null;
  }
}

export function extractLoginFormAction(html: string, baseUrl: string): string {
  const match = html.match(
    /action\s*=\s*["']([^"']*login-actions\/authenticate[^"']*)["']/i,
  );
  if (!match?.[1]) {
    throw new SlcmProtocolError("The SSO login form action was not found.");
  }

  try {
    return new URL(decodeHtml(match[1]), baseUrl).toString();
  } catch (error) {
    throw new SlcmProtocolError("The SSO login form action is invalid.", {
      cause: error,
    });
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
