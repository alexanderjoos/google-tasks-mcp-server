import { test } from "node:test";
import assert from "node:assert/strict";
import { linkedAccounts, resolveAccounts } from "../src/accounts.ts";
import { createGoogleClient, GoogleApiError } from "../src/google-api.ts";

test("linkedAccounts reads new and pre-multi-account grants", () => {
  assert.deepEqual(linkedAccounts({ accounts: { "a@x.edu": "r1", "b@gmail.com": "r2" } }), { "a@x.edu": "r1", "b@gmail.com": "r2" });
  assert.deepEqual(linkedAccounts({ email: "B@gmail.com", googleRefreshToken: "r" }), { "b@gmail.com": "r" });
  assert.deepEqual(linkedAccounts(undefined), {});
});

test("resolveAccounts orders files by allowlist and picks the Tasks account", () => {
  const linked = { "b@gmail.com": "r2", "a@x.edu": "r1" };
  const allowed = ["a@x.edu", "b@gmail.com"];
  assert.deepEqual(resolveAccounts(linked, allowed, "B@gmail.com "), { files: ["a@x.edu", "b@gmail.com"], tasks: "b@gmail.com" });
  // No preference, or a preference that isn't linked: first file account.
  assert.deepEqual(resolveAccounts(linked, allowed, undefined).tasks, "a@x.edu");
  assert.deepEqual(resolveAccounts({ "a@x.edu": "r1" }, allowed, "b@gmail.com").tasks, "a@x.edu");
  // Removed from the allowlist: no longer used.
  assert.deepEqual(resolveAccounts(linked, ["b@gmail.com"], undefined), { files: ["b@gmail.com"], tasks: "b@gmail.com" });
  assert.deepEqual(resolveAccounts(linked, [], undefined), { files: [], tasks: undefined });
});

test("createGoogleClient falls back to the next account on 403/404 only", async (t) => {
  const seen: string[] = [];
  const statusByToken: Record<string, number> = {};
  t.mock.method(globalThis, "fetch", async (_url: URL, init: RequestInit) => {
    const token = (init.headers as Record<string, string>).Authorization!.replace("Bearer ", "");
    seen.push(token);
    const status = statusByToken[token] ?? 200;
    return new Response(JSON.stringify(status === 200 ? { ok: token } : { error: { message: `from ${token}` } }), { status });
  });
  const request = createGoogleClient("Google Docs", "https://example.test", [async () => "school", async () => "personal"]);

  // First account works: second never tried.
  assert.deepEqual(await request("GET", "/doc"), { ok: "school" });
  assert.deepEqual(seen, ["school"]);

  // No access in the first account: the second one opens it.
  seen.length = 0;
  statusByToken.school = 404;
  assert.deepEqual(await request("GET", "/doc"), { ok: "personal" });
  assert.deepEqual(seen, ["school", "personal"]);

  // Both fail: the first account's error is reported.
  statusByToken.personal = 403;
  await assert.rejects(request("GET", "/doc"), (e: GoogleApiError) => e.status === 404 && e.message === "from school");

  // Other errors (bad request, auth) aren't retried.
  seen.length = 0;
  statusByToken.school = 400;
  await assert.rejects(request("GET", "/doc"), (e: GoogleApiError) => e.status === 400);
  assert.deepEqual(seen, ["school"]);
});
