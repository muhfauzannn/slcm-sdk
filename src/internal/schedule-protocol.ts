import { SlcmProtocolError } from "../errors.js";
import type {
  SlcmActivePeriod,
  SlcmClass,
  SlcmClassType,
  SlcmMyClasses,
  SlcmPeriod,
} from "../types.js";

export function parsePeriodsResponse(value: unknown): SlcmPeriod[] {
  const data = responseData(value, "all-periods");
  return data.map((item, index) => {
    const record = recordAt(item, `all-periods data[${index}]`);
    return {
      year: numberField(record, "year"),
      term: numberField(record, "term"),
      period: stringField(record, "period"),
      value: stringField(record, "value"),
    };
  });
}

export function parseClassTableResponse(
  value: unknown,
  type: SlcmClassType,
): SlcmClass[] {
  const data = responseData(value, `class/table?type=${type}`);
  return data.map((item, index) => {
    const record = recordAt(item, `class/table data[${index}]`);
    return {
      type,
      classCode: numberField(record, "classcode"),
      className: trimmedStringField(record, "classname"),
      language: trimmedStringField(record, "classlang"),
      courseCode: trimmedStringField(record, "coursecode"),
      courseName: trimmedStringField(record, "coursename"),
      curriculumCode: trimmedStringField(record, "currcode"),
      organizationCode: trimmedStringField(record, "orgcode"),
      offeredForTerm: numberField(record, "forterm"),
      credits: numberField(record, "sks"),
      isSpecial: numberField(record, "special") === 1,
      hidden: stringField(record, "hide"),
      dateRanges: nullableStringArrayField(record, "periods"),
      meetings: nullableStringArrayField(record, "dates_rooms"),
      lecturers: nullableStringArrayField(record, "lecturers").map((value) =>
        value.trim(),
      ),
      prerequisites: stringField(record, "prerequisites").trim(),
      editable: booleanField(record, "is_editable"),
      deletable: booleanField(record, "is_deleteable"),
    };
  });
}

export function parseMyClassesResponse(value: unknown): SlcmMyClasses {
  const response = recordAt(value, "course-plan/me/classes");
  if (!Array.isArray(response.data)) {
    throw new SlcmProtocolError(
      "course-plan/me/classes response does not contain a data array.",
    );
  }
  const warningStaleData = response["warning-stale-data"];
  if (typeof warningStaleData !== "boolean") {
    throw new SlcmProtocolError(
      "SLCM field warning-stale-data is not a boolean.",
    );
  }

  const classes = response.data.map((item, index) => {
    const record = recordAt(item, `course-plan/me/classes data[${index}]`);
    const periods = stringArrayField(record, "periods");
    const dates = stringArrayField(record, "dates");
    const rooms = stringArrayField(record, "rooms");
    if (periods.length !== dates.length || dates.length !== rooms.length) {
      throw new SlcmProtocolError(
        `SLCM meeting arrays have different lengths at data[${index}].`,
      );
    }

    return {
      classCode: trimmedStringField(record, "kode_kelas_mk"),
      className: trimmedStringField(record, "nama_kelas_mk"),
      courseCode: trimmedStringField(record, "kode_mata_kuliah"),
      courseName: trimmedStringField(record, "nama_mata_kuliah"),
      curriculumCode: trimmedStringField(record, "kode_kurikulum"),
      credits: numberField(record, "jumlah_sks"),
      scheduleText: stringField(record, "jadwal"),
      teachers: stringField(record, "teachers")
        .split(/\r?\n/)
        .map((teacher) => teacher.replace(/^\s*-\s*/, "").trim())
        .filter((teacher) => teacher.length > 0),
      hideUntil: nullableStringField(record, "hide_until"),
      meetings: periods.map((period, meetingIndex) => ({
        period: period.trim(),
        date: dates[meetingIndex]!.trim(),
        room: rooms[meetingIndex]!.trim(),
      })),
    };
  });

  return { classes, warningStaleData };
}

/**
 * `all-periods` has no active flag and includes future terms. SLCM labels an
 * academic year by its first semester: term 1 starts around August in `year`,
 * term 2 around January in `year + 1`, and term 3 around June in `year + 1`.
 */
export function resolveActivePeriod(
  periods: readonly SlcmPeriod[],
  active: SlcmActivePeriod | null,
): SlcmPeriod {
  if (active === null) {
    throw new SlcmProtocolError(
      "SLCM login summary does not contain activePeriod.",
    );
  }
  if (periods.length === 0) {
    throw new SlcmProtocolError("SLCM returned no academic periods.");
  }
  const selected = periods.find(
    (period) =>
      period.period === active.period ||
      (period.year === active.year && period.term === active.term),
  );
  if (!selected) {
    throw new SlcmProtocolError(
      `Active period ${active.period} from login summary is absent from all-periods.`,
    );
  }
  return selected;
}

function responseData(value: unknown, source: string): unknown[] {
  const response = recordAt(value, source);
  if (!Array.isArray(response.data)) {
    throw new SlcmProtocolError(`${source} response does not contain a data array.`);
  }
  return response.data;
}

function recordAt(value: unknown, source: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SlcmProtocolError(`${source} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new SlcmProtocolError(`SLCM field ${field} is not a string.`);
  }
  return value;
}

function trimmedStringField(
  record: Record<string, unknown>,
  field: string,
): string {
  return stringField(record, field).trim();
}

function numberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SlcmProtocolError(`SLCM field ${field} is not a number.`);
  }
  return value;
}

function booleanField(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new SlcmProtocolError(`SLCM field ${field} is not a boolean.`);
  }
  return value;
}

function nullableStringArrayField(
  record: Record<string, unknown>,
  field: string,
): string[] {
  const value = record[field];
  if (value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new SlcmProtocolError(
      `SLCM field ${field} is not an array of strings or null.`,
    );
  }
  return value;
}

function stringArrayField(
  record: Record<string, unknown>,
  field: string,
): string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new SlcmProtocolError(`SLCM field ${field} is not an array of strings.`);
  }
  return value;
}

function nullableStringField(
  record: Record<string, unknown>,
  field: string,
): string | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new SlcmProtocolError(`SLCM field ${field} is not a string or null.`);
  }
  return value;
}
