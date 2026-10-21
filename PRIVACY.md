# Privacy Policy

Last updated: 2026-10-20 (added Sheets and Docs)

gtasks-mcp is a personal tool. It lets Claude read and manage the Google Tasks, Google Sheets and Google Docs of the owner's own Google accounts, listed in its configuration. No other account can authorize it.

## What it accesses

- Your Google account email address, used only to check that you are the allowed user.
- Your Google Tasks (scope `https://www.googleapis.com/auth/tasks`), Google Sheets (`.../auth/spreadsheets`) and Google Docs (`.../auth/documents`), read and changed only when Claude calls one of the server's tools on your behalf. It has no Drive scope and does not list or browse your files.

## What it stores

- The Google refresh token and your email address, encrypted inside the OAuth grant in Cloudflare Workers KV. They're used only to get short-lived Google access tokens for Tasks, Sheets and Docs API calls.
- Short-lived records for the sign-in flow (CSRF state, consent nonce) that expire automatically.

Task, spreadsheet and document contents are not stored. They pass through the server between Google and Claude and are not kept.

## What it shares

Nothing is sold, shared, or used for advertising or analytics. Data goes only between Google's APIs, the Cloudflare Worker, and the Claude client you connect. Cloudflare's platform keeps standard request logs for the Worker.

## Revoking access

Remove the connector in Claude, and revoke the app at <https://myaccount.google.com/permissions>. Revoking on Google's side immediately invalidates the stored refresh token.

## Contact

Open an issue at <https://github.com/alexanderjoos/google-tasks-mcp-server/issues>.
