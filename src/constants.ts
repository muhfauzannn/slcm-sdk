import type { SlcmEndpoints } from "./types.js";

export const SLCM_CLIENT_ID = "slcm-beasiswa";
export const SLCM_BASE_URL = "https://slcm.ui.ac.id";
export const SLCM_REDIRECT_URI = `${SLCM_BASE_URL}/portal`;

export const SLCM_ENDPOINTS: Readonly<SlcmEndpoints> = Object.freeze({
  authorization:
    "https://login.ui.ac.id/realms/main/protocol/openid-connect/auth",
  token: "https://login.ui.ac.id/realms/main/protocol/openid-connect/token",
  user: `${SLCM_BASE_URL}/akademik/api/user`,
  activePeriod: `${SLCM_BASE_URL}/akademik/api/v1/class/period`,
  periods: `${SLCM_BASE_URL}/akademik/api/v1/shared/all-periods`,
  classTable: `${SLCM_BASE_URL}/akademik/api/v1/class/table`,
  myClasses: `${SLCM_BASE_URL}/akademik/api/course-plan/me/classes`,
});

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_REFRESH_MARGIN_MS = 60_000;
