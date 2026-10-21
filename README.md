# gtasks-mcp

A remote MCP server that lets Claude manage Google Tasks (the tasks in Google Calendar's Tasks panel) and edit Google Sheets and Docs in place. It runs on the Cloudflare Workers free plan, uses OAuth 2.1 so it works from claude.ai on web and mobile, and only one Google account can ever authorize it.

## What it's for

It adds connectors that Claude doesn't have a good built-in alternative for right now: Google Tasks, and editing Sheets and Docs in place. Claude's own Google connectors can read your files but can't change them.

It's a good fit if you have spare Cloudflare Workers requests: the free plan covers personal use, so running it is essentially free.

## Get started

1. Deploy it to your own Cloudflare account and Google Cloud project by following [SETUP.md](SETUP.md) (about 30 minutes, free).
2. In Claude, go to **Settings → Connectors → Add custom connector** and paste your Worker's `/mcp` URL.
3. Connect, sign in with the Google account you set as `ALLOWED_EMAIL`, and approve.
4. Ask Claude things like the examples above. For Sheets and Docs, paste the file's link, or let Claude's Google Drive connector find it.

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

There's deliberately no Drive scope: Drive's file-listing scopes are Google "restricted" scopes, and Claude's built-in Google Drive connector can already search and return the file link.

Every Tasks tool defaults to the main list (`@default`). Due dates are date-only, a Google Tasks API limitation. Use calendar events for anything with a time.

## How it works

```
Claude ──MCP (Streamable HTTP, OAuth 2.1)──▶ Worker ──Google access token──▶ Tasks / Sheets / Docs APIs
```

- `@cloudflare/workers-oauth-provider` makes the Worker an OAuth 2.1 authorization server. It supports Client ID Metadata Documents and Dynamic Client Registration, and gates `/mcp` behind bearer tokens.
- `/authorize` shows a consent page, then hands off to Google. `/callback` checks the Google account against `ALLOWED_EMAIL` and stores the Google refresh token in the grant's encrypted props. The token never reaches Claude.
- `/mcp` is stateless. Each request mints a fresh Google access token from the refresh token and serves one JSON-RPC exchange.

## Origin and security

This started as a fork of [Kouta-i5/google-tasks-mcp-server](https://github.com/Kouta-i5/google-tasks-mcp-server) (MIT). The Google OAuth client, Tasks API wrapper, and stateless MCP handler are based on that code; the Sheets and Docs tools are new.

The upstream code was audited before use. It was clean (no telemetry, talks only to Google, one-time CSRF state, refresh tokens stay server-side), and these issues were fixed:

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

Other changes from upstream: English throughout; `due_date` keeps the calendar date as written instead of shifting through UTC; the tools that could delete whole lists or bulk-clear completed tasks were dropped; the local stdio version was removed; CIMD registration was turned on with DCR as a fallback.

## Development

```bash
npm run dev        # local server on :8788 (needs .dev.vars)
npm run check      # typecheck + unit tests
npm run deploy
```

## License

[MIT](LICENSE)
