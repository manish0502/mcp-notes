import type { Server as HttpServer } from "node:http";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createNotesServer } from "../mcp/server.js";
import { isConnected } from "../config/db.js";
import type { NoteService } from "../services/note.service.js";

export interface HttpOptions {
  port?: number;
  host?: string;
}

/**
 * Streamable HTTP transport, on Express.
 *
 * `createMcpExpressApp` from the SDK gives us an app with DNS-rebinding protection
 * (Host header validation) and express.json() already wired, in that order — a request
 * with a disallowed Host is rejected before its body is parsed.
 *
 * This runs STATELESS: a fresh McpServer and transport per request, no session id. That
 * is the right default for a service with no per-connection state — it scales
 * horizontally with no sticky routing. Pass a sessionIdGenerator instead if you need
 * server-initiated messages or long-lived streams.
 */
export async function startHttp(
  service: NoteService,
  options: HttpOptions = {},
): Promise<() => Promise<void>> {
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";

  const app = createMcpExpressApp({ host });

  // A plain Express route, for load balancers and for you at 2am.
  app.get("/healthz", (_req, res) => {
    res.status(isConnected() ? 200 : 503).json({
      status: isConnected() ? "ok" : "degraded",
      mongo: isConnected(),
    });
  });

  app.post("/mcp", async (req, res) => {
    const server = createNotesServer(service);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    // Tear both down when the client goes away, or every request leaks a server.
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("mcp-notes: request failed", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // In stateless mode there is no stream to resume and no session to end.
  const notAllowed = (_req: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed: this server is stateless" },
      id: null,
    });
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  const httpServer: HttpServer = await new Promise((resolve) => {
    const listening = app.listen(port, host, () => resolve(listening));
  });

  console.error(`mcp-notes: listening on http://${host}:${port}/mcp`);

  return async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  };
}
