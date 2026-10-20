# gtasks-mcp

A remote MCP server that lets Claude manage Google Tasks (the tasks in Google Calendar's Tasks panel) and edit Google Sheets and Docs in place. It runs on the Cloudflare Workers free plan, uses OAuth 2.1 so it works from claude.ai on web and mobile, and only one Google account can ever authorize it.

Setup: see [SETUP.md](SETUP.md). Original requirements: [PLAN.md](PLAN.md).

## Tools

| Tool | What it does |
|---|---|
| `list_task_lists` | List task lists (to find a `list_id`) |
| `list_tasks` | Open tasks by default; `show_completed`, inclusive `due_after` / `due_before` filters |
| `get_task` | One task by ID |
| `create_task` | `title`, `notes?`, `due_date?` (YYYY-MM-DD), `list_id?`, `parent_id?` (subtask) |
| `update_task` | Change title, notes, or due date (`due_date: null` removes it) |
| `complete_task` | Mark done, or `completed: false` to reopen |
| `delete_task` | Permanent delete |

Sheets and Docs tools take a file URL or ID:

| Tool | What it does |
|---|---|
| `sheets_get_info` | Title and tabs with sizes |
| `sheets_read` | Read a range, as displayed, raw, or as formulas (capped at 5,000 cells) |
| `sheets_write` | Overwrite a range; input is parsed like typing in the UI unless `raw` |
| `sheets_append_rows` | Add rows under the existing data in a tab |
| `sheets_clear` | Clear values in a range |
| `sheets_add_tab` | Add a tab |
| `sheets_create` | New spreadsheet, optional tabs and starting rows |
| `docs_read` | Doc as light Markdown (first tab only) |
| `docs_append` | Add paragraphs at the end |
| `docs_insert_after` | Add paragraphs after the one paragraph matching some text, e.g. a heading |
| `docs_replace_text` | Replace every occurrence of some text, keeping formatting |
| `docs_create` | New doc with optional content |

Docs inserts understand `#`/`##`/`###` headings and `-` bullets, one paragraph per line. Index-based edits are computed from a fresh read and sent with the doc's revision ID, so a concurrent edit makes the call fail instead of landing in the wrong place.

There's deliberately no Drive scope: Drive's file-listing scopes are Google "restricted" scopes, and Claude's built-in Google Drive connector can already search and return the file link. Paste a link or let Claude find it there, then edit through these tools.

Every Tasks tool defaults to the main list (`@default`). Due dates are date-only, a Google Tasks API limitation. Use calendar events for anything with a time.

## How it works

```
Claude ──MCP (Streamable HTTP, OAuth 2.1)──▶ Worker ──Google access token──▶ Google Tasks API
```

- `@cloudflare/workers-oauth-provider` makes the Worker an OAuth 2.1 authorization server. It supports Client ID Metadata Documents and Dynamic Client Registration, and gates `/mcp` behind bearer tokens.
- `/authorize` shows a consent page, then hands off to Google. `/callback` checks the Google account against `ALLOWED_EMAIL` and stores the Google refresh token in the grant's encrypted props. The token never reaches Claude.
- `/mcp` is stateless. Each request mints a Google access token from the refresh token and serves one JSON-RPC exchange.

## Origin and audit

This started as a fork of [Kouta-i5/google-tasks-mcp-server](https://github.com/Kouta-i5/google-tasks-mcp-server), which is MIT per its `package.json`. The Google OAuth client, Tasks API wrapper, and stateless MCP handler are based on that code.

The audit found the upstream code clean: no telemetry, it talks only to Google, it uses one-time CSRF state, and refresh tokens stay server-side. These issues were fixed:

| Issue | Severity | Fix |
|---|---|---|
| No redirect URI restriction. Open client registration let anyone register a client with their own redirect URI and send the owner a login link, which would hand the attacker a token to the owner's tasks. | High | Redirect hosts are allowlisted (`ALLOWED_REDIRECT_HOSTS`), https only except loopback. |
| Auto-approved authorization with no consent step. The library docs say not to do this. | Medium | Added a consent page naming the client, bound to the browser by an HttpOnly SameSite=Lax cookie, so a forged cross-site POST can't approve. |
| Reflected XSS. The Google `error` parameter and the email were inserted into HTML unescaped. | Medium | Everything rendered is escaped. HTML responses also send a restrictive CSP, `X-Frame-Options: DENY`, and `no-store`. |
| `email_verified` was not checked. | Low | The allowlist now requires a verified email. |
| `AuthorizationError` from `parseAuthRequest` was unhandled, so bad requests returned a 500. | Low | Handled per the library docs. It redirects only to allowlisted URIs and otherwise renders locally. |
| The author's KV namespace ID and Google client ID were hardcoded in `wrangler.jsonc`. | Config | Replaced with a placeholder ID. The client ID moved to secrets. |
| Token endpoint errors echoed Google's response body. | Low | Only the status and error code are surfaced. |
| `wrangler` had vulnerable transitive dependencies (undici). | Dev only | Updated. `npm audit` is clean. |

These changes adapt it to PLAN.md:

- English throughout, and tool names and arguments match the plan.
- `due_date` takes `YYYY-MM-DD` and keeps the calendar date as written. Upstream converted through UTC, so a "9 PM tomorrow" timestamp in New York would land on the wrong day.
- Inclusive `due_before`, plus `list_tasks` pagination capped at 300.
- The upstream tools that could delete whole lists or bulk-clear completed tasks were dropped. Fewer destructive tools means fewer ways for a model to do damage.
- The local stdio version was removed. The remote server already works in Claude Code.
- CIMD support (the current MCP spec's preferred registration method) was turned on, with DCR kept as a fallback.

### Deviations from PLAN.md

- **No `COOKIE_ENCRYPTION_KEY`.** The consent cookie holds a random nonce that is compared against a server-side KV record, so there's nothing to encrypt.
- **Access tokens refresh on every request** instead of using `tokenExchangeCallback`. It adds about one Google round trip per MCP request, and refresh tokens never leave server-side storage.

## Development

```bash
npm run dev        # local server on :8788 (needs .dev.vars)
npm run check      # typecheck + unit tests (redirect allowlist, escaping, date handling)
npm run deploy
```
