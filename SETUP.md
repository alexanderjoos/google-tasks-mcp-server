# Setup

About 30 minutes, most of it in the Google Cloud console. You need Node 20+ and a free Cloudflare account.

```bash
npm install
```

## 1. Google Cloud

1. Go to <https://console.cloud.google.com> and create a project (or reuse one).
2. **APIs & Services → Library →** enable **Google Tasks API**, **Google Sheets API**, and **Google Docs API**.
3. **Google Auth Platform** (formerly "OAuth consent screen"):
   - **Branding:** app name (e.g. "Tasks MCP"), your email as support and developer contact.
   - **Audience:** User type **External**. Add your Gmail as a test user.
   - **Data Access:** add scopes `openid`, `.../auth/userinfo.email`, `https://www.googleapis.com/auth/tasks`, `https://www.googleapis.com/auth/spreadsheets`, and `https://www.googleapis.com/auth/documents`.
   - **Audience → Publish app** (move it to **In production**). This matters: in Testing mode Google expires refresh tokens after 7 days, and the connector would break weekly. You don't need Google's verification for personal use; you'll click through an "unverified app" warning once when you sign in.
4. **Clients → Create client → Web application.** Add these **Authorized redirect URIs**:
   - `http://localhost:8788/callback` (local testing)
   - `https://gtasks-mcp.<your-subdomain>.workers.dev/callback` (production; fill in after step 2 shows your subdomain, or add it later)
5. Copy the **Client ID** and **Client secret**.

## 2. Cloudflare

```bash
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
```

Paste the printed `id` into `wrangler.jsonc` in place of `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`. (The ID isn't secret; it's fine to commit.)

Set the secrets:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ALLOWED_EMAIL      # your Gmail address, the only account allowed to connect
```

## 3. Test locally (optional but recommended)

```bash
cp .dev.vars.example .dev.vars   # fill in the same three values
npm run dev                      # http://localhost:8788
```

In another terminal:

```bash
npx @modelcontextprotocol/inspector
```

Connect to `http://localhost:8788/mcp` with Streamable HTTP. You should get the consent page, then Google sign-in, then the tools. Try `list_task_lists`.

## 4. Deploy

```bash
npm run deploy
```

It prints the URL, e.g. `https://gtasks-mcp.<your-subdomain>.workers.dev`. Make sure `https://gtasks-mcp.<your-subdomain>.workers.dev/callback` is in the Google client's redirect URIs (step 1.4). Check `/health` returns `ok`.

## 5. Connect Claude

Add a custom connector in Claude's connector settings with the URL:

```
https://gtasks-mcp.<your-subdomain>.workers.dev/mcp
```

Connecting opens the consent page → **Approve** → Google sign-in. It works in claude.ai on web and mobile, Claude Desktop, and Claude Code (`claude mcp add --transport http gtasks https://.../mcp`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Redirect not allowed" | The client's callback host isn't in `ALLOWED_REDIRECT_HOSTS` (`wrangler.jsonc`). The page shows the rejected URL. Add its host only if you recognize it, then redeploy. |
| "Not allowed" after Google sign-in | You signed in with an account other than `ALLOWED_EMAIL`. |
| "No refresh token" | Remove the app at <https://myaccount.google.com/permissions> and connect again. |
| Sheets/Docs tools say access "wasn't granted" | The connector was authorized before those scopes existed, or a checkbox was left unticked on Google's consent screen. Disconnect and reconnect, and allow everything. |
| "API isn't enabled" | Enable the Sheets or Docs API in the Google Cloud project (step 1.2). |
| Tools say the Google sign-in expired | Reconnect the connector. If it happens every ~7 days, the Google app is still in Testing mode (step 1.3). |
| `redirect_uri_mismatch` from Google | The `/callback` URL for this environment isn't in the Google client's redirect URIs. |
