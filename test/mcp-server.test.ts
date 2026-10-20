import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { connectDb, disconnectDb } from "../src/config/db.js";
import { createNotesServer } from "../src/mcp/server.js";
import { NoteModel } from "../src/models/note.model.js";
import { NoteService } from "../src/services/note.service.js";

/**
 * Tests the MCP surface the way a real client sees it: a genuine Client talking to a
 * genuine McpServer over InMemoryTransport — same code path as stdio, no process spawn.
 *
 * This is the single most useful test to write for an MCP server. It catches schema
 * mistakes, missing annotations and handler bugs that a unit test on the service cannot.
 */
const TEST_URI = "mongodb://127.0.0.1:27017/mcp_notes_mcp_test";

let client: Client;
let service: NoteService;

beforeAll(async () => {
  await connectDb(TEST_URI);
  service = new NoteService();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createNotesServer(service);

  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
});

beforeEach(async () => {
  await NoteModel.deleteMany({});
});

afterAll(async () => {
  await NoteModel.deleteMany({});
  await client.close();
  await disconnectDb();
});

describe("tools/list", () => {
  it("advertises exactly the four tools", async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_note",
      "delete_note",
      "search_notes",
      "update_note",
    ]);
  });

  it("publishes a JSON Schema generated from the zod shapes", async () => {
    const { tools } = await client.listTools();
    const add = tools.find((tool) => tool.name === "add_note")!;

    expect(add.inputSchema.type).toBe("object");
    expect(Object.keys(add.inputSchema.properties ?? {})).toEqual(["text", "tags", "project"]);
    expect(add.inputSchema.required).toEqual(["text"]);
  });

  it("carries the zod descriptions through to the model", async () => {
    const { tools } = await client.listTools();
    const add = tools.find((tool) => tool.name === "add_note")!;
    const text = (add.inputSchema.properties as Record<string, { description?: string }>).text;

    expect(text?.description).toBe("The note content");
  });

  it("marks search_notes read-only and delete_note destructive", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(byName.get("search_notes")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("delete_note")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("add_note")?.annotations?.destructiveHint).toBe(false);
    expect(byName.get("update_note")?.annotations?.idempotentHint).toBe(true);
  });
});

describe("tools/call", () => {
  it("adds a note and finds it again", async () => {
    const added = await client.callTool({
      name: "add_note",
      arguments: { text: "Fix the login redirect", tags: ["Bug", "auth"], project: "web" },
    });

    expect(textOf(added)).toContain("Fix the login redirect");
    expect(textOf(added)).toContain("tags: bug, auth");

    const found = await client.callTool({
      name: "search_notes",
      arguments: { tag: "bug" },
    });

    expect(textOf(found)).toContain("1 note(s)");
    expect(textOf(found)).toContain("Fix the login redirect");
  });

  it("says so plainly when nothing matches", async () => {
    const result = await client.callTool({ name: "search_notes", arguments: { text: "nothing" } });
    expect(textOf(result)).toBe("No notes matched.");
  });

  it("updates a note through the protocol", async () => {
    const added = await client.callTool({ name: "add_note", arguments: { text: "todo" } });
    const id = idFrom(textOf(added));

    const updated = await client.callTool({
      name: "update_note",
      arguments: { id, done: true },
    });

    expect(textOf(updated)).toContain("(done)");
  });

  it("deletes a note through the protocol", async () => {
    const added = await client.callTool({ name: "add_note", arguments: { text: "goodbye" } });
    const id = idFrom(textOf(added));

    const deleted = await client.callTool({ name: "delete_note", arguments: { id } });

    expect(textOf(deleted)).toContain("Deleted");
    expect(await NoteModel.countDocuments()).toBe(0);
  });

  it("returns isError for a bad id rather than failing the request", async () => {
    const result = await client.callTool({
      name: "update_note",
      arguments: { id: "made-up-id", done: true },
    });

    // The CALL succeeded; the TOOL reported a problem. That distinction is the whole
    // point of isError — the model can read this and recover.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No note with id");
  });

  it("rejects arguments that violate the schema, before the handler runs", async () => {
    // No `text`, which zod marks required. The SDK validates for us — but note that it
    // does NOT throw: the violation comes back as an isError result carrying the reason,
    // so the model can read what it got wrong and retry. The handler never ran.
    const result = await client.callTool({ name: "add_note", arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid arguments for tool add_note");
    expect(textOf(result)).toContain("text");
    expect(await NoteModel.countDocuments()).toBe(0);
  });

  it("reports an unknown tool as an isError result, not a transport failure", async () => {
    const result = await client.callTool({ name: "nope", arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Tool nope not found");
  });
});

describe("resources", () => {
  it("lists both resources with their URIs", async () => {
    const { resources } = await client.listResources();

    expect(resources.map((resource) => resource.uri).sort()).toEqual([
      "notes://all",
      "notes://tags",
    ]);
  });

  it("serves every note as JSON", async () => {
    await service.add({ text: "readable", tags: ["x"] });
    const result = await client.readResource({ uri: "notes://all" });

    const parsed: unknown = JSON.parse(resourceText(result.contents[0]!));
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as Array<{ text: string }>)[0]!.text).toBe("readable");
    expect(result.contents[0]!.mimeType).toBe("application/json");
  });

  it("serves the tag index", async () => {
    await service.add({ text: "a", tags: ["bug"] });
    await service.add({ text: "b", tags: ["bug"] });

    const result = await client.readResource({ uri: "notes://tags" });
    expect(JSON.parse(resourceText(result.contents[0]!))).toEqual([{ tag: "bug", count: 2 }]);
  });
});

describe("prompts", () => {
  it("lists the prompt with its string arguments", async () => {
    const { prompts } = await client.listPrompts();
    const review = prompts.find((prompt) => prompt.name === "review_open_notes")!;

    expect(review.arguments?.map((argument) => argument.name).sort()).toEqual(["project", "tag"]);
  });

  it("returns messages that seed a conversation, not an answer", async () => {
    await service.add({ text: "Open thing", project: "web" });
    const result = await client.getPrompt({
      name: "review_open_notes",
      arguments: { project: "web" },
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe("user");
    expect(messageText(result.messages[0]!.content)).toContain("Open thing");
  });

  it("handles the empty case without pretending there is work", async () => {
    const result = await client.getPrompt({ name: "review_open_notes", arguments: {} });
    expect(messageText(result.messages[0]!.content)).toContain("no open notes");
  });
});

/** A tool result's content blocks are a union (text | image | audio | resource). */
function textOf(result: unknown): string {
  const blocks = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return blocks.map((block) => block.text ?? "").join("\n");
}

/** Resource contents are either text or a base64 blob — narrow with `in`. */
function resourceText(contents: { uri: string } & ({ text: string } | { blob: string })): string {
  return "text" in contents ? contents.text : "";
}

/** Prompt message content is a union too; only the text variant has `.text`. */
function messageText(content: { type: string } & Record<string, unknown>): string {
  return content.type === "text" ? String(content.text) : "";
}

function idFrom(text: string): string {
  return /\[([0-9a-f]{24})\]/.exec(text)?.[1] ?? "";
}
