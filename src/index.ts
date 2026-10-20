#!/usr/bin/env node
import { connectDb, disconnectDb, MONGODB_URI } from "./config/db.js";
import { NoteService } from "./services/note.service.js";
import { startHttp } from "./transports/http.js";
import { startStdio } from "./transports/stdio.js";

/**
 * Composition root. The only file that knows which transport is in play, and the only
 * place the database connection is opened.
 *
 *   npm start                        stdio (what Claude Code spawns)
 *   MCP_TRANSPORT=http npm start     streamable HTTP on Express
 */
const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();

// Connect to Mongo BEFORE announcing readiness. A client that gets a successful
// initialize and then fails every tool call is worse than one that fails to start.
await connectDb();
console.error(`mcp-notes: mongo connected (${MONGODB_URI})`);

const service = new NoteService();
const stop = transport === "http" ? await startHttp(service) : await startStdio(service);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void stop()
      .then(() => disconnectDb())
      .finally(() => process.exit(0));
  });
}
