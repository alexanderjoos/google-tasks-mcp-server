/**
 * Shared fetch helper for Google REST APIs (Tasks, Sheets, Docs). fetch only, since the
 * googleapis packages don't run on Workers.
 */

export type AccessTokenProvider = () => Promise<string>;

/** Thrown when Google returns a non-2xx response. Keeps the HTTP status and which API failed. */
export class GoogleApiError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

export interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
}

/**
 * Returns a request function bound to one API's base URL, e.g. "https://sheets.googleapis.com/v4".
 *
 * With several accounts, a 403 or 404 (no access to that file) is retried with the next account,
 * and if every account fails, the first account's error is thrown. A failed request changed
 * nothing, so retrying writes is safe.
 */
export function createGoogleClient(service: string, base: string, accounts: AccessTokenProvider[]) {
  if (accounts.length === 0) throw new Error("No Google account is linked. Reconnect the connector.");
  return async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    let firstError: GoogleApiError | undefined;
    for (const getAccessToken of accounts) {
      try {
        return await send<T>(service, base, getAccessToken, method, path, options);
      } catch (error) {
        if (!(error instanceof GoogleApiError) || (error.status !== 403 && error.status !== 404)) throw error;
        firstError ??= error;
      }
    }
    throw firstError!;
  };
}

async function send<T>(
  service: string,
  base: string,
  getAccessToken: AccessTokenProvider,
  method: string,
  path: string,
  options: RequestOptions,
): Promise<T> {
  const url = new URL(base + path);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null) continue;
    // Arrays become repeated params (e.g. Sheets' ranges=A1&ranges=B2).
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
    else url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  if (!response.ok) {
    const text = await response.text();
    let detail = text;
    try {
      detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
    } catch {
      // not JSON, use the raw body
    }
    throw new GoogleApiError(service, response.status, detail);
  }

  // DELETE returns 204 with an empty body.
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
