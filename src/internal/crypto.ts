import { createHash, randomBytes, randomUUID } from "node:crypto";

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export interface PkceAuthorization {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
  nonce: string;
}

export function createPkceAuthorization(): PkceAuthorization {
  const codeVerifier = base64url(randomBytes(32));
  return {
    codeVerifier,
    codeChallenge: createHash("sha256")
      .update(codeVerifier)
      .digest("base64url"),
    state: randomUUID(),
    nonce: randomUUID(),
  };
}
