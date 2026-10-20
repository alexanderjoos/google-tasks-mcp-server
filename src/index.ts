/**
 * Worker entry point.
 *
 * OAuthProvider serves the OAuth 2.1 authorization server (/.well-known metadata, /token,
 * /register, CIMD) and only lets requests with a valid bearer token through to /mcp.
 * The browser-facing pieces (/authorize consent, Google callback) live in google-handler.ts.
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import googleHandler from "./google-handler.js";
import mcpHandler from "./mcp-handler.js";

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler: googleHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  // Client ID Metadata Documents: the preferred registration method in the current MCP spec.
  // Needs the global_fetch_strictly_public flag in wrangler.jsonc.
  clientIdMetadataDocumentEnabled: true,
  // Dynamic Client Registration, kept for clients that don't support CIMD yet.
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["tasks"],
});
