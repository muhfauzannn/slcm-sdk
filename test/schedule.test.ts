import assert from "node:assert/strict";
import test from "node:test";

import { SlcmClient, type SlcmClassType } from "../src/index.js";

const endpoints = {
  authorization: "https://login.test/authorize",
  token: "https://login.test/token",
  user: "https://slcm.test/user",
  periods: "https://slcm.test/all-periods",
  classTable: "https://slcm.test/class/table",
};

test("schedule uses login activePeriod even when a future period is listed first", async () => {
  let state = "";
  const requestedTypes: string[] = [];
  const xAppToken = jwt({ userInfo: { org_code: "06.00.12.01" } });

  const mockFetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin === "https://login.test" && url.pathname === "/authorize") {
      state = url.searchParams.get("state") ?? "";
      return new Response(
        '<form action="https://login.test/login-actions/authenticate"></form>',
      );
    }
    if (url.pathname === "/login-actions/authenticate") {
      return new Response(null, {
        status: 302,
        headers: {
          location: `https://slcm.test/portal#state=${state}&code=code`,
        },
      });
    }
    if (url.href === endpoints.token) {
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        id_token: "id",
        token_type: "Bearer",
        expires_in: 360,
      });
    }
    if (url.href === endpoints.user) {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer access");
      return Response.json({
        data: {
          userToken: xAppToken,
          activePeriod: { year: 2026, term: 1, period: "2026-1" },
        },
      });
    }
    if (url.href === endpoints.periods) {
      assertAuthHeaders(init, xAppToken);
      return Response.json({
        data: [
          { year: 2026, term: 2, period: "2026-2", value: "" },
          { year: 2026, term: 1, period: "2026-1", value: "" },
          { year: 2025, term: 3, period: "2025-3", value: "" },
        ],
        message: "University periods retrieved successfully",
      });
    }
    if (url.origin + url.pathname === endpoints.classTable) {
      assertAuthHeaders(init, xAppToken);
      assert.equal(url.searchParams.get("year"), "2026");
      assert.equal(url.searchParams.get("term"), "1");
      assert.equal(url.searchParams.get("lang"), "id");
      const type = url.searchParams.get("type") as SlcmClassType;
      requestedTypes.push(type);
      return Response.json({
        data: [classFixture(type)],
        message: "Table Class is successfully retrieved",
      });
    }
    throw new Error(`Unexpected URL: ${url.href}`);
  };

  const session = await new SlcmClient({
    fetch: mockFetch,
    endpoints,
    redirectUri: "https://slcm.test/portal",
    retries: 0,
  }).login({ username: "student", password: "secret" });

  const period = await session.getActivePeriod();
  assert.deepEqual(period, {
    year: 2026,
    term: 1,
    period: "2026-1",
    value: "",
  });

  const schedule = await session.getSchedule();
  assert.equal(schedule.period.period, "2026-1");
  assert.equal(schedule.classes.length, 3);
  assert.deepEqual(requestedTypes.sort(), ["external", "group", "internal"]);
  assert.equal(schedule.byType.internal[0]?.courseName, "Example Course");
  assert.deepEqual(schedule.byType.external[0]?.meetings, []);
  assert.deepEqual(schedule.byType.external[0]?.lecturers, []);
  assert.equal(schedule.byType.group[0]?.type, "group");
});

function classFixture(type: SlcmClassType): Record<string, unknown> {
  const nullable = type === "external";
  return {
    classcode: type === "internal" ? 820926 : type === "group" ? 820521 : 812055,
    classname: `${type} A`,
    classlang: "Indonesia",
    coursecode: "TEST600001",
    currcode: "06.00.12.01-2024",
    orgcode: "06.00.12.01",
    coursename: "Example Course ",
    forterm: 1,
    sks: 3,
    special: 0,
    search: "test600001example course",
    hide: "",
    periods: nullable ? null : ["24/08/2026 - 18/12/2026"],
    dates_rooms: nullable ? null : ["Selasa, 10:00-11:40 (A6.01)"],
    lecturers: nullable ? null : [" Lecturer Name "],
    prerequisites: "",
    is_editable: true,
    is_deleteable: true,
  };
}

function assertAuthHeaders(init: RequestInit, xAppToken: string): void {
  const headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), "Bearer access");
  assert.equal(headers.get("x-app-token"), xAppToken);
}

function jwt(payload: unknown): string {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}
