import { SlcmProtocolError } from "../errors.js";
import type {
  SlcmActivePeriod,
  SlcmClass,
  SlcmClassType,
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
