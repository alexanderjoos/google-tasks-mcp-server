#!/usr/bin/env node
/**
 * Google Tasks MCP サーバー（stdio）。
 *
 * 注意: stdout は MCP の JSON-RPC が占有している。
 * ログは必ず stderr（console.error）に出すこと。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./shared/tools.js";
import { createTasksApi } from "./auth.js";
import type { TasksApi } from "./shared/tasks-api.js";

const server = new McpServer({
  name: "google-tasks-mcp-server",
  version: "0.1.0",
});

// 遅延初期化。未認証でもサーバーは起動し、ツール実行時に理由を返す。
let cached: Promise<TasksApi> | null = null;
registerTools(server, () => {
  cached ??= createTasksApi().catch((error: unknown) => {
    cached = null; // 失敗した Promise を残すと認証後も回復しないため破棄する
    throw error;
  });
  return cached;
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error("[google-tasks-mcp] stdio で待機中");
}

main().catch((error: unknown) => {
  console.error("[google-tasks-mcp] 起動に失敗しました:", error);
  process.exit(1);
});
