# Periods and offered schedules without the SDK

All endpoints in this document require both authenticated headers:

```http
Authorization: Bearer <access_token>
x-app-token: <x-app-token>
```

## Resolve the active period

Request the logged-in account's authoritative period summary:

```http
GET https://slcm.ui.ac.id/akademik/api/v1/class/period
```

The response contains a `data` array of period objects:

```json
{
  "data": [
    { "year": 2026, "term": 1, "period": "2026-1" }
  ]
}
```

The first entry from this endpoint is the session's active period identity.
Treat an empty or malformed response as a protocol failure.

Next, retrieve the complete period list:

```http
GET https://slcm.ui.ac.id/akademik/api/v1/shared/all-periods
```

```json
{
  "data": [
    { "year": 2026, "term": 2, "period": "2026-2", "value": "" },
    { "year": 2026, "term": 1, "period": "2026-1", "value": "" }
  ]
}
```

The complete list may place a future period first. Never use `data[0]` from
`all-periods` as the active period and never infer it from the current date.
Match the summary identity by `period`, or by the exact `year` and `term` pair.
Fail if the authoritative summary is absent from the complete list.

```js
const summary = await authenticatedJson(
  "https://slcm.ui.ac.id/akademik/api/v1/class/period",
);
const all = await authenticatedJson(
  "https://slcm.ui.ac.id/akademik/api/v1/shared/all-periods",
);

const identity = summary.data[0];
const activePeriod = all.data.find(
  (item) =>
    item.period === identity.period ||
    (item.year === identity.year && item.term === identity.term),
);
if (!activePeriod) throw new Error("Active period is absent from all-periods");
```

## Read offered classes

Request all three supported categories for the selected period:

```http
GET https://slcm.ui.ac.id/akademik/api/v1/class/table?type=internal&year=2026&term=1&lang=id
GET https://slcm.ui.ac.id/akademik/api/v1/class/table?type=group&year=2026&term=1&lang=id
GET https://slcm.ui.ac.id/akademik/api/v1/class/table?type=external&year=2026&term=1&lang=id
```

There is no supported `type=all`; fetch the categories separately. They are
read-only and can be requested concurrently.

```js
const base = "https://slcm.ui.ac.id/akademik/api/v1/class/table";
const types = ["internal", "group", "external"];

const tables = await Promise.all(
  types.map(async (type) => {
    const url = new URL(base);
    url.search = new URLSearchParams({
      type,
      year: String(activePeriod.year),
      term: String(activePeriod.term),
      lang: "id",
    });
    const body = await authenticatedJson(url);
    return body.data.map((item) => ({ ...item, type }));
  }),
);

const offeredClasses = tables.flat();
```

## Raw class-table fields

| Provider field | Type | Notes |
| --- | --- | --- |
| `classcode` | number | Class identifier for this endpoint. |
| `classname` | string | Class display name. |
| `classlang` | string | Teaching language. |
| `coursecode` | string | Course code. |
| `coursename` | string | Often contains trailing whitespace. |
| `currcode` | string | Curriculum code. |
| `orgcode` | string | Owning organization code. |
| `forterm` | number | Curriculum term. |
| `sks` | number | Credits. |
| `special` | number | `1` means special class. |
| `hide` | string | Provider visibility value. |
| `periods` | string[] or null | Date ranges. |
| `dates_rooms` | string[] or null | Day/time and room strings. |
| `lecturers` | string[] or null | Lecturer names. |
| `prerequisites` | string | Prerequisite text. |
| `is_editable` | boolean | Provider flag. |
| `is_deleteable` | boolean | Provider spelling is intentional. |

Normalize nullable arrays to empty arrays only at your application boundary.
Trim user-facing names, but preserve IDs and codes exactly.

## Offered does not mean taken

Class-table results are the classes offered to the account. They can include
hundreds of options that are not in the user's course plan. Use the endpoint in
[User course-plan classes](course-plan.md) when you need only taken classes.
