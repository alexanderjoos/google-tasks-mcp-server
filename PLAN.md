# Google Tasks MCP Server on Cloudflare Workers

## Goal

A remote MCP server, hosted for free on Cloudflare Workers, that lets Claude (claude.ai web/mobile, Claude Desktop, Claude Code) create and manage tasks in my Google Tasks (the tasks that show up in Google Calendar). It replaces a Zapier integration whose auth kept expiring.

Single user (me). Only my Google account should ever be able to authorize it.

## Before you start

The Cloudflare MCP and OAuth libraries move fast. Before writing code, check the current docs and templates rather than relying on memory:

- Cloudflare guide for remote MCP servers with OAuth: https://developers.cloudflare.com/agents/guides/remote-mcp-server/
- `@cloudflare/workers-oauth-provider` README (npm / GitHub)
- `agents` package (`McpAgent` or `createMcpHandler`)
- Cloudflare's `cloudflare/ai` repo has demo templates for remote MCP servers with third-party OAuth (GitHub, Google). If a Google OAuth template exists, start from it.
- Google Tasks API reference: https://developers.google.com/workspace/tasks/reference/rest

If the docs contradict anything below, follow the docs and note the change.

## Architecture

```
Claude  --(MCP over Streamable HTTP, OAuth 2.1)-->  Cloudflare Worker  --(Google OAuth access token)-->  Google Tasks API
```

The Worker plays two OAuth roles:

1. **OAuth provider to Claude.** `@cloudflare/workers-oauth-provider` handles `/authorize`, `/token`, `/register` (dynamic client registration), and validates bearer tokens on `/mcp`. Claude connects to it like any custom connector.
2. **OAuth client to Google.** During `/authorize`, the Worker redirects to Google, receives the code at `/callback`, exchanges it for Google access and refresh tokens, and stores them in the grant `props` (the provider encrypts props at rest in KV).

Tool handlers read the Google access token from `props` and call the Tasks API with `fetch`. When the Google access token expires, refresh it with the stored refresh token (use the provider's `tokenExchangeCallback` hook if available, otherwise refresh on 401 inside the tool handler).

Prefer the stateless MCP handler if the `agents` package offers one. If only `McpAgent` (Durable Objects) is available, that's fine too: SQLite-backed Durable Objects work on the Workers free plan.

## Google Cloud setup (manual, I'll do this)

1. Create a Google Cloud project (or reuse one).
2. Enable the **Google Tasks API**.
3. OAuth consent screen: User type External, add my Gmail as a test user, add scope `https://www.googleapis.com/auth/tasks`.
4. **Publish the app to Production.** In Testing mode, refresh tokens expire after 7 days. An unverified production app is fine for personal use (I'll click through the "unverified app" warning once).
5. Create an OAuth client ID (Web application) with redirect URIs:
   - `http://localhost:8788/callback` (local dev)
   - `https://<worker-name>.<subdomain>.workers.dev/callback` (prod)
6. Save the client ID and secret.

Write a short `SETUP.md` walking through these steps.

## Google OAuth details

- Auth URL: `https://accounts.google.com/o/oauth2/v2/auth`
- Token URL: `https://oauth2.googleapis.com/token`
- Scopes: `openid email https://www.googleapis.com/auth/tasks`
- Params: `access_type=offline`, `prompt=consent` (needed to get a refresh token every time)
- After the token exchange, read the user's email (from the ID token or `https://openidconnect.googleapis.com/v1/userinfo`). **If it doesn't match `ALLOWED_EMAIL`, reject the authorization.** This is what keeps the server single-user.
- Use a signed/encrypted cookie or KV entry for the `state` parameter to prevent CSRF.

## MCP tools

All tools return concise JSON or text. Default list is `@default`.

| Tool | Args | Google API call |
|---|---|---|
| `list_task_lists` | none | `GET /tasks/v1/users/@me/lists` |
| `list_tasks` | `list_id?`, `show_completed?` (default false), `due_before?` (YYYY-MM-DD) | `GET /tasks/v1/lists/{list}/tasks` |
| `create_task` | `title`, `notes?`, `due_date?` (YYYY-MM-DD), `list_id?` | `POST /tasks/v1/lists/{list}/tasks` |
| `update_task` | `task_id`, `list_id?`, `title?`, `notes?`, `due_date?` | `PATCH /tasks/v1/lists/{list}/tasks/{task}` |
| `complete_task` | `task_id`, `list_id?` | `PATCH` with `status: "completed"` |
| `delete_task` | `task_id`, `list_id?` | `DELETE /tasks/v1/lists/{list}/tasks/{task}` |

Base URL: `https://tasks.googleapis.com`

Notes:
- **The Tasks API ignores the time part of `due`.** Send `due` as `"YYYY-MM-DDT00:00:00.000Z"` and say in the tool description that due dates are date-only.
- Validate inputs with zod. Write clear tool descriptions, since Claude picks tools from them.
- `list_tasks` should return id, title, notes, due, status so Claude can follow up with update/complete/delete.
- Map Google API errors to readable messages (401 = needs reauth, 404 = bad task/list id).

## Config

`wrangler.jsonc`:
- KV namespace binding `OAUTH_KV` (required by workers-oauth-provider)
- Durable Object binding only if using `McpAgent`
- `compatibility_flags: ["nodejs_compat"]` if the libraries need it

Secrets (`wrangler secret put` for prod, `.dev.vars` for local, gitignored):
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `COOKIE_ENCRYPTION_KEY` (random 32+ bytes)
- `ALLOWED_EMAIL` (my Gmail address)

Endpoints:
- `/mcp` (Streamable HTTP, protected)
- `/authorize`, `/callback`, `/token`, `/register` (OAuth)
- `/` returns a plain "ok" health check

## Project layout (suggested)

```
gtasks-mcp/
  src/
    index.ts          # OAuthProvider setup, routing
    google-handler.ts # /authorize + /callback, Google token exchange, email allowlist
    mcp.ts            # MCP server + tool definitions
    tasks-api.ts      # thin typed wrapper around Google Tasks REST
  wrangler.jsonc
  .dev.vars.example
  SETUP.md
  README.md
```

TypeScript, no Python.

## Build order

1. Scaffold from the Cloudflare remote MCP OAuth template (Google variant if it exists). Get it running with `wrangler dev`.
2. Implement Google OAuth with the email allowlist. Confirm the full flow with MCP Inspector (`npx @modelcontextprotocol/inspector`, connect to `http://localhost:8788/mcp`).
3. Implement `tasks-api.ts` and `list_task_lists` first as the smoke test, then the rest of the tools.
4. Add token refresh. Test it by forcing an expired access token.
5. Deploy with `wrangler deploy`, set prod secrets, add the prod redirect URI in Google Cloud.
6. Add the deployed `/mcp` URL to Claude as a custom connector and test end to end.

## Acceptance criteria

- [ ] Connecting from claude.ai triggers Google sign-in, and only `ALLOWED_EMAIL` can complete it
- [ ] "Add 'call dad about Fidelity contact' due tomorrow" creates a task visible in Google Calendar's Tasks panel on the right date
- [ ] list, update, complete, and delete all work from Claude
- [ ] Still works after more than an hour (access token refresh) and after more than 7 days (production refresh token)
- [ ] No secrets in the repo; `.dev.vars` is gitignored
- [ ] Stays within the Workers free plan

## Out of scope

- Multi-user support
- Timed reminders (the Tasks API can't do this; calendar events cover it)
- Subtasks and task ordering (`parent` / `move`), unless trivial to add later
