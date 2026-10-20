import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, getCookie, isAllowedRedirect, nextDay, normalizeDue, parseHostList, safeEqual } from "../src/util.ts";

const hosts = parseHostList("claude.ai, claude.com,localhost,127.0.0.1");

test("parseHostList trims, lowercases, drops blanks", () => {
  assert.deepEqual(parseHostList(" Claude.ai, ,localhost "), ["claude.ai", "localhost"]);
  assert.deepEqual(parseHostList(undefined), []);
});

test("isAllowedRedirect accepts Claude and loopback", () => {
  assert.ok(isAllowedRedirect("https://claude.ai/api/mcp/auth_callback", hosts));
  assert.ok(isAllowedRedirect("https://claude.com/api/mcp/auth_callback", hosts));
  assert.ok(isAllowedRedirect("https://sub.claude.ai/cb", hosts));
  assert.ok(isAllowedRedirect("http://localhost:6274/oauth/callback", hosts));
  assert.ok(isAllowedRedirect("http://127.0.0.1:33418/callback", hosts));
});

test("isAllowedRedirect rejects attacker hosts and tricks", () => {
  assert.equal(isAllowedRedirect("https://evil.com/cb", hosts), false);
  assert.equal(isAllowedRedirect("https://claude.ai.evil.com/cb", hosts), false);
  assert.equal(isAllowedRedirect("https://evilclaude.ai/cb", hosts), false);
  assert.equal(isAllowedRedirect("https://claude.ai@evil.com/cb", hosts), false);
  assert.equal(isAllowedRedirect("http://claude.ai/cb", hosts), false, "plain http off loopback");
  assert.equal(isAllowedRedirect("javascript:alert(1)", hosts), false);
  assert.equal(isAllowedRedirect("not a url", hosts), false);
  assert.equal(isAllowedRedirect("https://claude.ai/cb", []), false);
});

test("escapeHtml neutralizes markup", () => {
  assert.equal(escapeHtml(`<script>alert("x")</script>&'`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
});

test("getCookie finds the right cookie", () => {
  assert.equal(getCookie("a=1; gtasks_csrf=abc; b=2", "gtasks_csrf"), "abc");
  assert.equal(getCookie("xgtasks_csrf=abc", "gtasks_csrf"), null);
  assert.equal(getCookie(null, "gtasks_csrf"), null);
});

test("safeEqual", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "ab"), false);
});

test("normalizeDue keeps the calendar date as written", () => {
  assert.equal(normalizeDue("2026-10-21"), "2026-10-21T00:00:00.000Z");
  // Late evening in New York is the next day in UTC; we must keep the 21st.
  assert.equal(normalizeDue("2026-10-21T21:00:00-04:00"), "2026-10-21T00:00:00.000Z");
  assert.equal(normalizeDue(" 2026-02-28 "), "2026-02-28T00:00:00.000Z");
  assert.throws(() => normalizeDue("tomorrow"));
  assert.throws(() => normalizeDue("2026-02-30"));
  assert.throws(() => normalizeDue("2026-13-01"));
});

test("nextDay rolls over months and years", () => {
  assert.equal(nextDay("2026-10-21"), "2026-10-22T00:00:00.000Z");
  assert.equal(nextDay("2026-10-31"), "2026-11-01T00:00:00.000Z");
  assert.equal(nextDay("2026-12-31"), "2027-01-01T00:00:00.000Z");
});
