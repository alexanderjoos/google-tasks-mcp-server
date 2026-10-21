/**
 * Small pure helpers. No Worker globals, so they can be unit tested under Node.
 */

/** Escape text for safe interpolation into HTML. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Parse a comma-separated list ("claude.ai, localhost" or emails) into lowercase entries. */
export function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether an OAuth redirect URI is allowed.
 *
 * Client registration is open (DCR/CIMD), so anyone can register a client with any redirect URI.
 * Without this check, an attacker could register a client pointing at their own site, send the
 * owner a login link, and receive a token for the owner's tasks. Restricting redirect hosts to
 * known MCP clients closes that hole.
 *
 * Rules: https only, except http on localhost/127.0.0.1 (local tools like MCP Inspector).
 * A host matches if it equals an allowed host or is a subdomain of one.
 */
export function isAllowedRedirect(redirectUri: string, allowedHosts: string[]): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) return false;
  return allowedHosts.some((allowed) => host === allowed || host.endsWith("." + allowed));
}

/** Read one cookie from a Cookie header. */
export function getCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Constant-time string comparison, so CSRF token checks don't leak timing. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Normalize a due date for the Google Tasks API.
 *
 * Google Tasks stores only the date and discards the time. Accepts "YYYY-MM-DD" or any
 * RFC 3339 string, and takes the calendar date exactly as written. Converting through UTC
 * would shift "2026-10-21T21:00:00-04:00" to the 22nd, which is not what the user meant.
 */
export function normalizeDue(value: string): string {
  const match = DATE_PREFIX.exec(value.trim());
  if (!match) throw new Error(`Can't read "${value}" as a date. Use YYYY-MM-DD.`);
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(m) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    throw new Error(`"${value}" is not a real calendar date.`);
  }
  return `${y}-${m}-${d}T00:00:00.000Z`;
}

/** Return the day after a YYYY-MM-DD (or RFC 3339) date as an RFC 3339 midnight UTC string. */
export function nextDay(value: string): string {
  const start = new Date(normalizeDue(value));
  start.setUTCDate(start.getUTCDate() + 1);
  return start.toISOString();
}

/**
 * Accept a Google Sheets/Docs URL or a bare file ID and return the ID.
 * Handles /spreadsheets/d/<id>/..., /document/d/<id>/..., and Drive's ?id=<id> links.
 */
export function parseGoogleFileId(input: string): string {
  const value = input.trim();
  const fromPath = /\/d\/([A-Za-z0-9_-]{10,})/.exec(value);
  if (fromPath) return fromPath[1]!;
  try {
    const id = new URL(value).searchParams.get("id");
    if (id && /^[A-Za-z0-9_-]{10,}$/.test(id)) return id;
  } catch {
    // not a URL
  }
  if (/^[A-Za-z0-9_-]{10,}$/.test(value)) return value;
  throw new Error(`"${input}" is not a Google file URL or ID.`);
}

/** Quote a tab name for A1 notation: My Tab -> 'My Tab', O'Brien -> 'O''Brien'. */
export function quoteTabName(tab: string): string {
  return `'${tab.replaceAll("'", "''")}'`;
}

/** 1-based column number to A1 letters: 1 -> A, 27 -> AA. */
export function columnLetter(column: number): string {
  let letters = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}
