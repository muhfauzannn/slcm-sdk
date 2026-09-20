import { SlcmClient } from "./dist/index.js";

const username = process.env.SSO_UI_USERNAME;
const password = process.env.SSO_UI_PASSWORD;

if (!username || !password) {
  console.error(
    "SSO_UI_USERNAME and SSO_UI_PASSWORD must be set. See README.md under Live login verification.",
  );
  process.exit(2);
}

const client = new SlcmClient({
  onEvent(event) {
    if (event.type === "login:start" || event.type === "login:success") {
      console.log(event.type);
    }
  },
});

try {
  const session = await client.login({ username, password });

  console.log({
    success: true,
    username: session.user?.username ?? null,
    fullName: session.user?.full_name ?? null,
    orgCode: session.orgCode,
    role: session.role,
    hasAccessToken: session.tokens.accessToken.length > 0,
    hasXAppToken: session.xAppToken.length > 0,
  });
} catch (error) {
  console.error({
    success: false,
    name: error instanceof Error ? error.name : "UnknownError",
    code:
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : null,
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
