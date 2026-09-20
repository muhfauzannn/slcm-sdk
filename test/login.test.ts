import assert from "node:assert/strict";
import test from "node:test";

import {
  SlcmAuthenticationError,
  SlcmClient,
  SlcmInvalidArgumentError,
} from "../src/index.js";

const endpoints = {
  authorization: "https://login.test/authorize",
  token: "https://login.test/token",
  user: "https://slcm.test/user",
};

test("login completes PKCE, obtains x-app-token, and exposes metadata", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let expectedState = "";
  const xAppToken = jwt({
    userInfo: {
      username: "student",
      full_name: "Student Example",
      org_code: "06.00.12.01",
      role: "student",
    },
  });

  const mockFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.startsWith(endpoints.authorization)) {
      const authorization = new URL(url);
      expectedState = authorization.searchParams.get("state") ?? "";
      assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
      assert.ok(authorization.searchParams.get("code_challenge"));
      return response(
        '<form action="https://login.test/login-actions/authenticate?session=x&amp;execution=y"></form>',
        { headers: { "set-cookie": "AUTH_SESSION_ID=cookie-value; Path=/" } },
      );
    }

    if (url.startsWith("https://login.test/login-actions/authenticate")) {
      assert.match(header(init.headers, "cookie"), /AUTH_SESSION_ID=cookie-value/);
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get("username"), "student");
      assert.equal(body.get("password"), "secret");
      return response(null, {
        status: 302,
        headers: {
          location: `https://slcm.test/portal#state=${expectedState}&code=auth-code`,
        },
      });
    }

    if (url === endpoints.token) {
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("code"), "auth-code");
      assert.ok(body.get("code_verifier"));
      return json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        id_token: "id-token",
        token_type: "Bearer",
        expires_in: 360,
      });
    }

    if (url === endpoints.user) {
      assert.equal(header(init.headers, "authorization"), "Bearer access-token");
      return json({ data: { userToken: xAppToken } });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const client = new SlcmClient({
    fetch: mockFetch,
    endpoints,
    redirectUri: "https://slcm.test/portal",
    retries: 0,
  });
  const session = await client.login({ username: "student", password: "secret" });

  assert.equal(session.orgCode, "06.00.12.01");
  assert.equal(session.role, "student");
  assert.equal(session.user?.full_name, "Student Example");
  assert.equal(session.tokens.accessToken, "access-token");
  assert.deepEqual(await session.getAuthHeaders(), {
    Authorization: "Bearer access-token",
    "x-app-token": xAppToken,
  });
  assert.equal(calls.length, 4);
});

test("session refresh replaces tokens and x-app-token", async () => {
  let tokenRequests = 0;
  const initialXAppToken = jwt({ userInfo: { org_code: "old" } });
  const refreshedXAppToken = jwt({ userInfo: { org_code: "new" } });
  let expectedState = "";

  const mockFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith(endpoints.authorization)) {
      expectedState = new URL(url).searchParams.get("state") ?? "";
      return response(
        '<form action="https://login.test/login-actions/authenticate"></form>',
      );
    }
    if (url.includes("login-actions/authenticate")) {
      return response(null, {
        status: 302,
        headers: {
          location: `https://slcm.test/portal#state=${expectedState}&code=code`,
        },
      });
    }
    if (url === endpoints.token) {
      tokenRequests += 1;
      const isRefresh = new URLSearchParams(String(init.body)).get("grant_type") === "refresh_token";
      return json({
        access_token: isRefresh ? "access-2" : "access-1",
        ...(isRefresh ? {} : { refresh_token: "refresh-1", id_token: "id-1" }),
        token_type: "Bearer",
        expires_in: 360,
      });
    }
    if (url === endpoints.user) {
      const refreshed = header(init.headers, "authorization").endsWith("access-2");
      return json({
        data: { userToken: refreshed ? refreshedXAppToken : initialXAppToken },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const session = await new SlcmClient({
    fetch: mockFetch,
    endpoints,
    redirectUri: "https://slcm.test/portal",
    retries: 0,
  }).login({ username: "student", password: "secret" });

  await session.refresh();
  assert.equal(session.tokens.accessToken, "access-2");
  assert.equal(session.tokens.refreshToken, "refresh-1");
  assert.equal(session.tokens.idToken, "id-1");
  assert.equal(session.orgCode, "new");
  assert.equal(tokenRequests, 2);
});

test("invalid credentials produce a typed authentication error", async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith(endpoints.authorization)) {
      return response(
        '<form action="https://login.test/login-actions/authenticate"></form>',
      );
    }
    return response(
      '<div id="input-error">Invalid student / wrong.</div>',
      { status: 200 },
    );
  };

  const client = new SlcmClient({
    fetch: mockFetch,
    endpoints,
    redirectUri: "https://slcm.test/portal",
    retries: 0,
  });
  await assert.rejects(
    client.login({ username: "student", password: "wrong" }),
    (error: unknown) => {
      assert.ok(error instanceof SlcmAuthenticationError);
      assert.equal(error.code, "AUTHENTICATION_FAILED");
      assert.equal(error.message, "Invalid [redacted] / [redacted].");
      return true;
    },
  );
});

test("login rejects a redirect with a mismatched OIDC state", async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith(endpoints.authorization)) {
      return response(
        '<form action="https://login.test/login-actions/authenticate"></form>',
      );
    }
    return response(null, {
      status: 302,
      headers: {
        location: "https://slcm.test/portal#state=attacker&code=code",
      },
    });
  };

  const client = new SlcmClient({
    fetch: mockFetch,
    endpoints,
    redirectUri: "https://slcm.test/portal",
    retries: 0,
  });
  await assert.rejects(
    client.login({ username: "student", password: "secret" }),
    SlcmAuthenticationError,
  );
});

test("empty credentials fail before a network request", async () => {
  let called = false;
  const client = new SlcmClient({
    fetch: async () => {
      called = true;
      throw new Error("must not run");
    },
  });

  await assert.rejects(
    client.login({ username: "", password: "secret" }),
    SlcmInvalidArgumentError,
  );
  assert.equal(called, false);
});

function response(body: BodyInit | null, init?: ResponseInit): Response {
  return new Response(body, init);
}

function json(value: unknown): Response {
  return Response.json(value);
}

function header(headers: HeadersInit | undefined, name: string): string {
  return new Headers(headers).get(name) ?? "";
}

function jwt(payload: unknown): string {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}
