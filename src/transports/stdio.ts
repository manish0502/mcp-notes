import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createNotesServer } from "../mcp/server.js";
import type { NoteService } from "../services/note.service.js";

/**
 * stdio transport: the client spawns this process and talks over stdin/stdout.
 * This is what Claude Code and Claude Desktop use.
 *
 * THE ONE RULE: stdout is the JSON-RPC channel. A single console.log corrupts the
 * protocol stream and the client disconnects with a parse error. Diagnostics go to
 * stderr, always.
 */
export async function startStdio(service: NoteService): Promise<() => Promise<void>> {
  const server = createNotesServer(service);
  await server.connect(new StdioServerTransport());

  console.error("mcp-notes: listening on stdio");

  return async () => {
    await server.close();
  };
}
