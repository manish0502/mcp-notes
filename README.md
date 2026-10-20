# mcp-notes

An **MCP server** for capturing and querying project notes — backed by MongoDB, served
over stdio or Express. A complete, minimal reference implementation of all three MCP
primitives.

Stack: **MongoDB + Express + Node** (TypeScript), Mongoose ODM.

---

## What MCP actually gives you

Three primitives, and who controls each one is the part people get wrong:

| Primitive | Controlled by | Purpose | Here |
|---|---|---|---|
| **Tools** | the model | actions with side effects | `add_note`, `search_notes`, `update_note`, `delete_note` |
| **Resources** | the application | read-only data addressed by URI | `notes://all`, `notes://tags` |
| **Prompts** | the user | reusable templates, usually a slash command | `review_open_notes` |

Tools are the only primitive that can change anything. A resource is *read*, never
called. A prompt returns **messages** that seed a conversation — not an answer.

## How a request flows

```
  Claude Code / Desktop
          │  JSON-RPC over stdio  (or HTTP POST /mcp)
          ▼
  src/transports/        stdio.ts  │  http.ts  (Express)
          │
          ▼
  src/mcp/server.ts      tools · resources · prompts
          │              zod validates arguments before any handler runs
          ▼
  src/services/          business logic — knows Mongo, knows nothing about MCP
          │
          ▼
  src/models/            Mongoose schema → plain DTO
          │
          ▼
      MongoDB
```

Each layer only knows the one below it. The service has no idea it is being called over a
protocol, which is why it can be tested without one.

## The tools, and their annotations

`annotations` are hints to the client about what a tool does. They are advisory, not
enforced — but clients use them to decide what needs human approval and what is safe to
cache. Omit them and every caller must assume the worst.

| Tool | readOnly | destructive | idempotent | Why |
|---|---|---|---|---|
| `add_note` | no | no | no | writes, but only inserts — nothing is lost. Twice = two notes |
| `search_notes` | **yes** | – | – | safe to call freely, safe to cache |
| `update_note` | no | no | **yes** | overwrites fields; same patch twice = same end state |
| `delete_note` | no | **yes** | yes | the one tool a client should confirm first |

## Quick start

MongoDB must be running on `localhost:27017`.

```bash
npm install
```

```bash
npm test
```

```bash
npm run dev
```

Set `MONGODB_URI` to use a different database (default `mongodb://127.0.0.1:27017/mcp_notes`).

### Try it with the MCP Inspector

```bash
npm run inspect
```

### Register it with Claude Code or Claude Desktop

```json
{
  "mcpServers": {
    "notes": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-notes/src/index.ts"],
      "env": { "MONGODB_URI": "mongodb://127.0.0.1:27017/mcp_notes" }
    }
  }
}
```

### Or run it over HTTP

```bash
MCP_TRANSPORT=http PORT=3100 npm run dev
```

```bash
curl -s -X POST http://127.0.0.1:3100/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The HTTP mode is **stateless**: a fresh server per request, no session id, so it scales
horizontally with no sticky routing. There is also a plain `GET /healthz` that reports
whether Mongo is reachable.

## Layout

| Path | Job |
|---|---|
| `src/config/db.ts` | the only file that knows the Mongo URI |
| `src/models/note.model.ts` | Mongoose schema; converts documents to plain DTOs |
| `src/services/note.service.ts` | business logic and queries. No MCP here |
| `src/mcp/schemas.ts` | zod input shapes — these become the published JSON Schema |
| `src/mcp/server.ts` | the MCP surface: tools, resources, prompts |
| `src/transports/stdio.ts` | what Claude Code spawns |
| `src/transports/http.ts` | Express + streamable HTTP |
| `src/index.ts` | composition root: connect Mongo, pick a transport |
| `test/note.service.test.ts` | queries against real MongoDB |
| `test/mcp-server.test.ts` | a real MCP client talking to the server in-process |

## Five things worth knowing

**1. stdout is the protocol channel.** One `console.log` in a stdio server corrupts the
JSON-RPC stream and the client disconnects with a parse error. All diagnostics go to
stderr.

**2. `isError` is not an exception.** A bad note id returns `{ isError: true }` with a
readable message — the call *succeeded*, the tool reported a problem, and the model can
read it and retry. Throwing instead looks like a server fault.

**3. The SDK validates arguments for you.** The zod shapes in `src/mcp/schemas.ts` become
JSON Schema for `tools/list` *and* are enforced before your handler runs. A call missing a
required field never reaches your code — it comes back as an `isError` result naming the
offending field. You never hand-validate tool arguments.

**4. Prompt arguments are strings.** Tools accept rich JSON Schema types; prompts
transmit arguments as strings only. That is why `reviewPromptShape` exists separately
instead of reusing the search shape.

**5. `.describe()` is prompt engineering.** Every description in the zod shape is
published to the model and is how it decides which tool to call. Vague descriptions are
the most common reason a correct tool never gets used.

## Tests

36 tests, no mocks. `test/note.service.test.ts` runs real queries against a dedicated
database that is wiped between tests. `test/mcp-server.test.ts` wires a genuine MCP
`Client` to the server over `InMemoryTransport` — the same code path as stdio, without
spawning a process. That second file is the most valuable test to write for any MCP
server: it catches schema mistakes and missing annotations that service-level unit tests
cannot see.

They need a local mongod. For CI, add a MongoDB service container or swap in
`mongodb-memory-server`.

## License

MIT
