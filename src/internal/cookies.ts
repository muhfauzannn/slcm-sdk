interface StoredCookie {
  name: string;
  value: string;
}

export class CookieJar {
  readonly #cookies = new Map<string, StoredCookie>();

  header(): string {
    return [...this.#cookies.values()]
      .map(({ name, value }) => `${name}=${value}`)
      .join("; ");
  }

  update(response: Response): void {
    for (const raw of getSetCookieHeaders(response.headers)) {
      const pair = raw.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;

      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value.length === 0) this.#cookies.delete(name);
      else this.#cookies.set(name, { name, value });
    }
  }
}

function getSetCookieHeaders(headers: Headers): string[] {
  const enhanced = headers as Headers & { getSetCookie?: () => string[] };
  const values = enhanced.getSetCookie?.();
  if (values && values.length > 0) return values;

  const combined = headers.get("set-cookie");
  if (!combined) return [];

  // A comma starts a new cookie only when followed by a cookie-name and '='.
  return combined.split(/,(?=\s*[^;,=\s]+\s*=)/g).map((value) => value.trim());
}
