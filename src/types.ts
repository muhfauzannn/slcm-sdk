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
  activePeriod: string;
  periods: string;
  classTable: string;
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
  activePeriod: SlcmActivePeriod | null;
}

export type SlcmClassType = "internal" | "group" | "external";
export type SlcmLanguage = "id" | "en";

export interface SlcmPeriod {
  year: number;
  term: number;
  period: string;
  value: string;
}

export interface SlcmActivePeriod {
  year: number;
  term: number;
  period: string;
}

export interface SlcmClass {
  type: SlcmClassType;
  classCode: number;
  className: string;
  language: string;
  courseCode: string;
  courseName: string;
  curriculumCode: string;
  organizationCode: string;
  offeredForTerm: number;
  credits: number;
  isSpecial: boolean;
  hidden: string;
  dateRanges: string[];
  meetings: string[];
  lecturers: string[];
  prerequisites: string;
  editable: boolean;
  deletable: boolean;
}

export interface SlcmClassTableOptions {
  type: SlcmClassType;
  period?: SlcmPeriod;
  language?: SlcmLanguage;
  signal?: AbortSignal;
}

export interface SlcmScheduleOptions {
  period?: SlcmPeriod;
  language?: SlcmLanguage;
  signal?: AbortSignal;
}

export interface SlcmActivePeriodOptions {
  signal?: AbortSignal;
}

export interface SlcmSchedule {
  period: SlcmPeriod;
  classes: SlcmClass[];
  byType: Record<SlcmClassType, SlcmClass[]>;
}
