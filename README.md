# SLCM SDK

A type-safe Node.js SDK for logging in to SLCM and reading academic periods,
offered classes, and the classes taken by the logged-in user.

> This is an independent integration package, not an official Universitas
> Indonesia package. Only access accounts and systems you are authorized to use.

## Requirements

- Node.js 20 or newer
- An active SSO UI account

The package has no runtime dependencies and supports ESM and CommonJS.

## Installation

```bash
pnpm add slcm-sdk
```

## Login

```ts
import { SlcmClient } from "slcm-sdk";

const client = new SlcmClient();
const session = await client.login({
  username: process.env.SSO_UI_USERNAME!,
  password: process.env.SSO_UI_PASSWORD!,
});

console.log(session.user?.full_name);
console.log(session.orgCode);
console.log(session.role);
console.log(session.activePeriod);
```

Each `login()` call creates an independent session. Credentials, tokens, and
cookies are kept in memory and are not persisted by the SDK.

## Read the active period

```ts
const activePeriod = await session.getActivePeriod();

console.log(activePeriod);
// { year: 2026, term: 1, period: "2026-1", value: "" }
```

`session.activePeriod` is the authoritative identity returned by SLCM's period
summary during login. `getActivePeriod()` matches it against SLCM's complete
period list. It does not assume the first item in `all-periods` is active.

To read every available period:

```ts
const periods = await session.getPeriods();
```

## Read offered classes

`getSchedule()` loads all classes offered to the account for a period. These are
not necessarily classes taken by the user.

```ts
const schedule = await session.getSchedule();

console.log(schedule.period);
console.log(schedule.classes.length);
console.log(schedule.byType.internal);
console.log(schedule.byType.group);
console.log(schedule.byType.external);
```

The SDK requests the three categories concurrently and adds a `type` field to
each normalized class.

Pass a period or language explicitly when needed:

```ts
const schedule = await session.getSchedule({
  period: {
    year: 2026,
    term: 1,
    period: "2026-1",
    value: "",
  },
  language: "id",
});
```

To load one category only:

```ts
const internal = await session.getClassTable({
  type: "internal",
  period: await session.getActivePeriod(),
});
```

### Offered-class shape

```ts
interface SlcmClass {
  type: "internal" | "group" | "external";
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
```

Nullable SLCM arrays are normalized to empty arrays, and surrounding whitespace
in names is removed.

## Read classes taken by the user

Use `getMyClasses()` for classes in the logged-in user's current course plan:

```ts
const result = await session.getMyClasses();

if (result.warningStaleData) {
  console.warn("SLCM reports that this course-plan data may be stale.");
}

for (const courseClass of result.classes) {
  console.log(courseClass.courseName, courseClass.className);
  console.log(courseClass.teachers);

  for (const meeting of courseClass.meetings) {
    console.log(meeting.period, meeting.date, meeting.room);
  }
}
```

### Taken-class shape

```ts
interface SlcmEnrolledClass {
  classCode: string;
  className: string;
  courseCode: string;
  courseName: string;
  curriculumCode: string;
  credits: number;
  meetings: Array<{
    period: string;
    date: string;
    room: string;
  }>;
  teachers: string[];
  hideUntil: string | null;
  scheduleText: string;
}
```

## Refresh and authenticated headers

Refresh explicitly:

```ts
await session.refresh();
```

Or obtain both headers required by SLCM. The SDK refreshes a token first when it
is close to expiry:

```ts
const headers = await session.getAuthHeaders();

const response = await fetch("https://slcm.ui.ac.id/akademik/api/another-endpoint", {
  headers,
});
```

Treat `session.tokens`, `session.xAppToken`, snapshots, and generated headers as
secrets. Do not expose them to browser code or logs.

## Cancellation

Login and session methods accept an `AbortSignal`:

```ts
const controller = new AbortController();

const promise = client.login({
  username,
  password,
  signal: controller.signal,
});

controller.abort();
await promise;
```

```ts
const myClasses = await session.getMyClasses(controller.signal);
const schedule = await session.getSchedule({ signal: controller.signal });
```

## Client configuration

```ts
const client = new SlcmClient({
  timeoutMs: 10_000,
  retries: 2,
  retryDelayMs: 250,
  refreshMarginMs: 60_000,
  userAgent: "my-service/1.0",
  onEvent(event) {
    logger.info(event);
  },
});
```

Events never contain credentials or token values. A custom `fetch`, endpoint
map, OIDC client ID, and redirect URI can also be injected for tests or
controlled environments.

## Error handling

All SDK errors extend `SlcmError` and expose a stable `code`.

| Error class | Code | Meaning |
| --- | --- | --- |
| `SlcmAuthenticationError` | `AUTHENTICATION_FAILED` | Credentials, tokens, or OIDC validation failed. |
| `SlcmNetworkError` | `NETWORK_ERROR` | A network, timeout, rate-limit, or server failure remained after retries. |
| `SlcmProtocolError` | `PROTOCOL_ERROR` | SLCM returned an unexpected page or payload. |
| `SlcmInvalidArgumentError` | `INVALID_ARGUMENT` | SDK input or configuration is invalid. |

```ts
import { SlcmAuthenticationError } from "slcm-sdk";

try {
  await client.login({ username, password });
} catch (error) {
  if (error instanceof SlcmAuthenticationError) {
    // Ask the user to verify their SSO credentials.
  }
  throw error;
}
```

## Complete example

```ts
import { SlcmClient } from "slcm-sdk";

const session = await new SlcmClient().login({
  username: process.env.SSO_UI_USERNAME!,
  password: process.env.SSO_UI_PASSWORD!,
});

const [activePeriod, offeredSchedule, myClasses] = await Promise.all([
  session.getActivePeriod(),
  session.getSchedule(),
  session.getMyClasses(),
]);

console.log({
  activePeriod: activePeriod.period,
  offered: offeredSchedule.classes.length,
  taken: myClasses.classes.length,
  stale: myClasses.warningStaleData,
});
```

## Live verification

The repository includes a live smoke test that prints account metadata and
counts, never passwords or token values.

```bash
read "SSO_UI_USERNAME?SSO UI username: "
read -s "SSO_UI_PASSWORD?SSO UI password: "
echo

export SSO_UI_USERNAME SSO_UI_PASSWORD
pnpm verify:login
unset SSO_UI_USERNAME SSO_UI_PASSWORD
```

## Manual integration without this package

See [docs/README.md](docs/README.md) for protocol-level documentation covering
login, token refresh, periods, offered classes, and course-plan classes.
