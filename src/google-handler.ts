/**
 * Browser-facing OAuth flow: consent page, hand-off to Google, and the Google callback.
 *
 * To Claude, this Worker is the authorization server. Identity is delegated to Google, and the
 * Google refresh tokens are stored only inside the provider's encrypted grant props. They are never
 * sent to the MCP client.
 *
 * One connection can link several allowlisted Google accounts: after each Google sign-in, a page
 * offers to link the next one, or to finish with the accounts linked so far.
 *
 * Defenses, in order:
 *   1. Redirect URI host allowlist (open client registration otherwise allows token phishing).
 *   2. Explicit consent page naming the client, bound to the browser by a SameSite=Lax cookie,
 *      so a cross-site auto-submitted form can't approve on the owner's behalf.
 *   3. One-time, short-lived pending-authorization records in KV (CSRF "state" for Google).
 *   4. Allowlist on the verified Google email.
 */
import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env, UserProps } from "./env.js";
import { buildAuthUrl, exchangeCode, fetchUserEmail } from "./google-oauth.js";
import { escapeHtml, getCookie, isAllowedRedirect, parseList, safeEqual } from "./util.js";
import { resolveAccounts } from "./accounts.js";

const PENDING_PREFIX = "gtasks:pending:";
const PENDING_TTL_SECONDS = 600;
const CSRF_COOKIE = "gtasks_csrf";

interface Pending {
  authRequest: AuthRequest;
  csrf: string;
  clientName: string;
  /**
   * Accounts linked so far, email → refresh token. Held in KV only between sign-ins, for at most
   * PENDING_TTL_SECONDS, then moved into the encrypted grant.
   */
  accounts?: Record<string, string>;
}

const SECURITY_HEADERS = {
  // No form-action: browsers apply it to the post-submit redirects to Google and the client.
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

/** Render a small HTML page. `body` must already be escaped. */
function page(body: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Google Tasks MCP</title>` +
      `<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.25rem;line-height:1.6;color:#1a1a1a}` +
      `code{background:#f2f2f2;padding:.1em .35em;border-radius:.25em;word-break:break-all}` +
      `.row{display:flex;gap:.75rem;margin-top:1.5rem}button{font:inherit;padding:.6em 1.2em;border-radius:.4em;border:1px solid #999;background:#fff;cursor:pointer}` +
      `button.primary{background:#1a1a1a;color:#fff;border-color:#1a1a1a}</style>${body}</html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extraHeaders } },
  );
}

function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store", ...extraHeaders } });
}

function csrfCookie(value: string, maxAge: number): string {
  return `${CSRF_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function callbackUrl(request: Request): string {
  return new URL("/callback", request.url).toString();
}

/** Redirect back to an already-validated, allowlisted client redirect URI with an OAuth error. */
function clientError(authRequest: AuthRequest, code: string, description: string): Response {
  const url = new URL(authRequest.redirectUri);
  url.searchParams.set("error", code);
  url.searchParams.set("error_description", description);
  if (authRequest.state) url.searchParams.set("state", authRequest.state);
  return redirect(url.toString(), { "Set-Cookie": csrfCookie("", 0) });
}

/** Load a pending authorization and verify it belongs to this browser. */
async function loadPending(env: Env, request: Request, id: string | null): Promise<Pending | null> {
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const stored = await env.OAUTH_KV.get(PENDING_PREFIX + id);
  if (!stored) return null;
  const pending = JSON.parse(stored) as Pending;
  const cookie = getCookie(request.headers.get("Cookie"), CSRF_COOKIE);
  if (!cookie || !safeEqual(cookie, pending.csrf)) return null;
  return pending;
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  let authRequest: AuthRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    // Unknown clients and invalid redirects are rendered locally, never redirected.
    if (!error.redirectUri || !isAllowedRedirect(error.redirectUri, parseList(env.ALLOWED_REDIRECT_HOSTS))) {
      return page(`<h1>Invalid request</h1><p>${escapeHtml(error.description)}</p>`, 400);
    }
    const url = new URL(error.redirectUri);
    url.searchParams.set("error", error.code);
    url.searchParams.set("error_description", error.description);
    if (error.state) url.searchParams.set("state", error.state);
    if (error.issuer) url.searchParams.set("iss", error.issuer);
    return redirect(url.toString());
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (!client) return page("<h1>Unknown client</h1><p>This request came from an unregistered client.</p>", 400);

  if (!isAllowedRedirect(authRequest.redirectUri, parseList(env.ALLOWED_REDIRECT_HOSTS))) {
    return page(
      `<h1>Redirect not allowed</h1><p>This server only sends authorizations back to approved MCP clients. ` +
        `<code>${escapeHtml(authRequest.redirectUri)}</code> is not one of them.</p>` +
        `<p>To allow it, add its host to <code>ALLOWED_REDIRECT_HOSTS</code> in <code>wrangler.jsonc</code>.</p>`,
      400,
    );
  }

  const id = crypto.randomUUID();
  const csrf = randomToken();
  const clientName = client.clientName || authRequest.clientId;
  const pending: Pending = { authRequest, csrf, clientName };
  await env.OAUTH_KV.put(PENDING_PREFIX + id, JSON.stringify(pending), { expirationTtl: PENDING_TTL_SECONDS });

  const redirectHost = new URL(authRequest.redirectUri).host;
  return page(
    `<h1>Connect Google Tasks, Sheets and Docs?</h1>` +
      `<p><strong>${escapeHtml(clientName)}</strong> wants to read and edit your Google Tasks, Sheets and Docs.</p>` +
      `<p>After you approve, you'll sign in with Google, and access will be returned to <code>${escapeHtml(redirectHost)}</code>.</p>` +
      `<p>If you didn't just try to connect this, click Deny.</p>` +
      `<form method="post" action="/authorize/decide" class="row">` +
      `<input type="hidden" name="id" value="${escapeHtml(id)}">` +
      `<button class="primary" type="submit" name="decision" value="approve">Approve</button>` +
      `<button type="submit" name="decision" value="deny">Deny</button>` +
      `</form>`,
    200,
    { "Set-Cookie": csrfCookie(csrf, PENDING_TTL_SECONDS) },
  );
}

async function handleDecision(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const id = form.get("id");
  const decision = form.get("decision");
  const pending = await loadPending(env, request, typeof id === "string" ? id : null);
  if (!pending || typeof id !== "string") {
    return page("<h1>Session expired</h1><p>This approval is no longer valid. Start the connection again from Claude.</p>", 400);
  }

  if (decision === "finish" && pending.accounts && Object.keys(pending.accounts).length > 0) {
    await env.OAUTH_KV.delete(PENDING_PREFIX + id);
    return completeAuthorization(env, pending, pending.accounts);
  }

  if (decision !== "approve" && decision !== "link") {
    await env.OAUTH_KV.delete(PENDING_PREFIX + id);
    return clientError(pending.authRequest, "access_denied", "The user denied the request.");
  }

  // Preselect the next account only once an allowed account has signed in. Before that, anyone who
  // can reach the consent page would see the allowlisted email in the Google URL.
  const linked = pending.accounts ?? {};
  const next = Object.keys(linked).length ? parseList(env.ALLOWED_EMAIL).find((email) => !(email in linked)) : undefined;
  return redirect(
    buildAuthUrl({
      clientId: env.GOOGLE_CLIENT_ID,
      redirectUri: callbackUrl(request),
      state: id,
      loginHint: next,
    }),
  );
}

/**
 * After a Google sign-in, offer to link the next allowlisted account or finish. Stores the
 * pending authorization under a fresh one-time ID. `note` must already be escaped.
 */
async function linkNextPage(env: Env, pending: Pending, next: string, note = ""): Promise<Response> {
  const id = crypto.randomUUID();
  await env.OAUTH_KV.put(PENDING_PREFIX + id, JSON.stringify(pending), { expirationTtl: PENDING_TTL_SECONDS });
  const linked = Object.keys(pending.accounts ?? {});
  const finish = linked.length
    ? `<button type="submit" name="decision" value="finish">Finish with ${linked.length === 1 ? "this account" : "these accounts"}</button>`
    : `<button type="submit" name="decision" value="deny">Cancel</button>`;
  return page(
    `<h1>Link another account?</h1>${note}` +
      (linked.length ? `<p>Linked: ${linked.map((email) => `<code>${escapeHtml(email)}</code>`).join(", ")}</p>` : "") +
      `<p>You can also link <code>${escapeHtml(next)}</code>. Google Tasks use one account, and Sheets and Docs ` +
      `use whichever linked account can open the file.</p>` +
      `<form method="post" action="/authorize/decide" class="row">` +
      `<input type="hidden" name="id" value="${escapeHtml(id)}">` +
      `<button class="primary" type="submit" name="decision" value="link">Link ${escapeHtml(next)}</button>` +
      finish +
      `</form>`,
    200,
    { "Set-Cookie": csrfCookie(pending.csrf, PENDING_TTL_SECONDS) },
  );
}

async function completeAuthorization(env: Env, pending: Pending, accounts: Record<string, string>): Promise<Response> {
  const props: UserProps = { accounts };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: pending.authRequest,
    // The preferred file account, so reconnecting replaces the grant from the last connection.
    userId: resolveAccounts(accounts, parseList(env.ALLOWED_EMAIL), undefined).files[0] ?? Object.keys(accounts)[0]!,
    metadata: { clientName: pending.clientName },
    scope: pending.authRequest.scope.filter((s) => s === "tasks"),
    props,
    // Re-authorizing replaces the old grant instead of piling them up.
    revokeExistingGrants: true,
  });
  return redirect(redirectTo, { "Set-Cookie": csrfCookie("", 0) });
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("state");
  const pending = await loadPending(env, request, id);
  if (!pending || !id) {
    return page("<h1>Session expired</h1><p>This sign-in is no longer valid. Start the connection again from Claude.</p>", 400);
  }
  // One-time use.
  await env.OAUTH_KV.delete(PENDING_PREFIX + id);

  const allowed = parseList(env.ALLOWED_EMAIL);
  const nextUnlinked = () => allowed.find((email) => !(email in (pending.accounts ?? {})));

  const googleError = url.searchParams.get("error");
  if (googleError) {
    // A failed second sign-in (cancelled, or blocked by a school's admin) keeps the accounts already linked.
    const next = nextUnlinked();
    if (pending.accounts && next) {
      return linkNextPage(env, pending, next, `<p>Google returned <code>${escapeHtml(googleError)}</code>.</p>`);
    }
    return clientError(pending.authRequest, "access_denied", `Google returned: ${googleError}`);
  }

  const code = url.searchParams.get("code");
  if (!code) return page("<h1>Bad response</h1><p>Google did not return an authorization code.</p>", 400);

  const token = await exchangeCode({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    code,
    redirectUri: callbackUrl(request),
  });
  if (!token.refresh_token) {
    return page(
      "<h1>No refresh token</h1><p>Google didn't return a refresh token. Remove this app at " +
        '<a href="https://myaccount.google.com/permissions">Google account permissions</a>, then connect again.</p>',
      400,
    );
  }

  // Personal server: only the allowlisted, verified Google accounts may authorize.
  const { email, verified } = await fetchUserEmail(token.access_token);
  if (!verified || !allowed.includes(email.toLowerCase())) {
    const notAllowed = `<p><code>${escapeHtml(email)}</code> is not authorized to use this server.</p>`;
    const next = nextUnlinked();
    if (pending.accounts && next) return linkNextPage(env, pending, next, notAllowed);
    return page(`<h1>Not allowed</h1>${notAllowed}`, 403, { "Set-Cookie": csrfCookie("", 0) });
  }

  pending.accounts = { ...pending.accounts, [email.toLowerCase()]: token.refresh_token };
  const next = nextUnlinked();
  if (next) return linkNextPage(env, pending, next);
  return completeAuthorization(env, pending, pending.accounts);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize" && request.method === "GET") return handleAuthorize(request, env);
    if (url.pathname === "/authorize/decide" && request.method === "POST") return handleDecision(request, env);
    if (url.pathname === "/callback" && request.method === "GET") return handleCallback(request, env);

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/") {
      return page(
        "<h1>Google Tasks MCP server</h1>" +
          "<p>Add this as a custom connector in Claude.</p>" +
          `<p>MCP endpoint: <code>${escapeHtml(new URL("/mcp", request.url).toString())}</code></p>`,
      );
    }

    return page("<h1>Not found</h1>", 404);
  },
};
