# User course-plan classes without the SDK

This endpoint returns only classes currently taken by the logged-in user:

```http
GET https://slcm.ui.ac.id/akademik/api/course-plan/me/classes
Authorization: Bearer <access_token>
x-app-token: <x-app-token>
```

It does not accept a period query in the verified flow; the response follows the
logged-in user's current course plan.

## Response shape

```json
{
  "data": [
    {
      "kode_kelas_mk": "820927",
      "nama_kelas_mk": "Anaperancis B",
      "kode_mata_kuliah": "CSIM603183",
      "kode_kurikulum": "06.00.12.01-2024",
      "nama_mata_kuliah": "Analisis dan Perancangan Sistem Informasi ",
      "jumlah_sks": 3,
      "jadwal": "24/08/2026 - 18/12/2026\u001eSelasa, 10:00-11:40\u001eA6.02 (Ged Baru)",
      "teachers": "- Dr. Nabila Clydea Harahap, S.Kom., M.Kom.",
      "hide_until": null,
      "periods": ["24/08/2026 - 18/12/2026"],
      "dates": ["Selasa, 10:00-11:40"],
      "rooms": ["A6.02 (Ged Baru)"]
    }
  ],
  "message": "Success retrieve course plan checking.",
  "warning-stale-data": false
}
```

## Mapping rules

The provider uses Indonesian field names and a different model from
`class/table`.

| Provider field | Recommended application field | Notes |
| --- | --- | --- |
| `kode_kelas_mk` | `classCode` | String, not a number. |
| `nama_kelas_mk` | `className` | Trim whitespace. |
| `kode_mata_kuliah` | `courseCode` | Preserve exactly. |
| `nama_mata_kuliah` | `courseName` | Trim trailing whitespace. |
| `kode_kurikulum` | `curriculumCode` | Preserve exactly. |
| `jumlah_sks` | `credits` | Number. |
| `jadwal` | `scheduleText` | Raw display string; contains record-separator characters. |
| `teachers` | `teachers` | Newline-delimited string with `-` list markers. |
| `hide_until` | `hideUntil` | String or null. |
| `periods` + `dates` + `rooms` | `meetings` | Parallel arrays matched by index. |
| `warning-stale-data` | `warningStaleData` | Top-level boolean; do not discard. |

## Normalize meetings and teachers

Validate that all three meeting arrays have equal lengths. Silently truncating
with `zip` or using missing values can associate a class with the wrong room or
time.

```js
function normalizeCoursePlanClass(item) {
  if (
    item.periods.length !== item.dates.length ||
    item.dates.length !== item.rooms.length
  ) {
    throw new Error("SLCM meeting arrays have different lengths");
  }

  return {
    classCode: item.kode_kelas_mk.trim(),
    className: item.nama_kelas_mk.trim(),
    courseCode: item.kode_mata_kuliah.trim(),
    courseName: item.nama_mata_kuliah.trim(),
    curriculumCode: item.kode_kurikulum.trim(),
    credits: item.jumlah_sks,
    scheduleText: item.jadwal,
    hideUntil: item.hide_until,
    teachers: item.teachers
      .split(/\r?\n/)
      .map((teacher) => teacher.replace(/^\s*-\s*/, "").trim())
      .filter(Boolean),
    meetings: item.periods.map((period, index) => ({
      period: period.trim(),
      date: item.dates[index].trim(),
      room: item.rooms[index].trim(),
    })),
  };
}
```

## Stale data

When `warning-stale-data` is true, the response is still structurally valid but
SLCM is warning that it may not reflect the latest course-plan state. Preserve
the flag and let the consuming application decide how to inform the user.
