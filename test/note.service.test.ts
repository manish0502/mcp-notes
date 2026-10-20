import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { connectDb, disconnectDb } from "../src/config/db.js";
import { NoteModel } from "../src/models/note.model.js";
import { NoteService } from "../src/services/note.service.js";

/**
 * These run against a real mongod on localhost, in a dedicated database that is wiped
 * between tests. No mocks: the point is to verify the queries, not our idea of them.
 */
const TEST_URI = "mongodb://127.0.0.1:27017/mcp_notes_service_test";

let service: NoteService;

beforeAll(async () => {
  await connectDb(TEST_URI);
  service = new NoteService();
});

beforeEach(async () => {
  await NoteModel.deleteMany({});
});

afterAll(async () => {
  await NoteModel.deleteMany({});
  await disconnectDb();
});

describe("add", () => {
  it("returns a plain object with a string id, not a mongoose document", async () => {
    const note = await service.add({ text: "Fix the auth redirect" });

    expect(typeof note.id).toBe("string");
    expect(note.id).toMatch(/^[0-9a-f]{24}$/);
    expect(note.done).toBe(false);
    expect(note).not.toHaveProperty("_id");
  });

  it("gets createdAt and updatedAt from mongoose timestamps", async () => {
    const note = await service.add({ text: "x" });

    expect(new Date(note.createdAt).getTime()).toBeGreaterThan(0);
    expect(note.createdAt).toBe(note.updatedAt);
  });

  it("normalises tags in the schema: trimmed, lowercased, de-duplicated", async () => {
    const note = await service.add({ text: "x", tags: [" Bug ", "bug", "AUTH", ""] });
    expect(note.tags).toEqual(["bug", "auth"]);
  });

  it("persists to the database, not just to memory", async () => {
    const note = await service.add({ text: "durable" });
    expect(await NoteModel.countDocuments()).toBe(1);
    expect((await service.get(note.id))?.text).toBe("durable");
  });
});

describe("invalid ids", () => {
  it("returns null for a malformed id instead of throwing", async () => {
    // A model will invent ids. A CastError thrown here would surface as a server fault.
    expect(await service.get("not-an-objectid")).toBeNull();
    expect(await service.update("nope", { done: true })).toBeNull();
    expect(await service.remove("nope")).toBeNull();
  });

  it("returns null for a well-formed id that does not exist", async () => {
    expect(await service.get("507f1f77bcf86cd799439011")).toBeNull();
  });
});

describe("update", () => {
  it("changes only the fields passed", async () => {
    const note = await service.add({ text: "original", tags: ["a"], project: "web" });
    const updated = await service.update(note.id, { done: true });

    expect(updated?.done).toBe(true);
    expect(updated?.text).toBe("original");
    expect(updated?.tags).toEqual(["a"]);
    expect(updated?.project).toBe("web");
  });

  it("returns the document AFTER the update, not the stale one", async () => {
    const note = await service.add({ text: "before" });
    const updated = await service.update(note.id, { text: "after" });

    expect(updated?.text).toBe("after");
  });

  it("replaces tags rather than merging them", async () => {
    const note = await service.add({ text: "x", tags: ["a", "b"] });
    expect((await service.update(note.id, { tags: ["c"] }))?.tags).toEqual(["c"]);
  });

  it("is a no-op when the patch is empty", async () => {
    const note = await service.add({ text: "unchanged" });
    expect((await service.update(note.id, {}))?.text).toBe("unchanged");
  });
});

describe("remove", () => {
  it("deletes the document and returns what was deleted", async () => {
    const note = await service.add({ text: "temporary" });
    const removed = await service.remove(note.id);

    expect(removed?.id).toBe(note.id);
    expect(await NoteModel.countDocuments()).toBe(0);
  });
});

describe("search", () => {
  beforeEach(async () => {
    await service.add({ text: "Fix auth redirect loop", tags: ["bug", "auth"], project: "web" });
    await service.add({ text: "Write the migration guide", tags: ["docs"], project: "web" });
    await service.add({ text: "Benchmark the query planner", tags: ["perf"], project: "db" });
  });

  it("matches a substring, case-insensitively", async () => {
    const found = await service.search({ text: "AUTH" });
    expect(found).toHaveLength(1);
    expect(found[0]!.text).toContain("auth redirect");
  });

  it("matches mid-word, which a $text index could not", async () => {
    expect(await service.search({ text: "edirect" })).toHaveLength(1);
  });

  it("neutralises regex metacharacters in user input", async () => {
    // Without escaping, ".*" would match every note.
    expect(await service.search({ text: ".*" })).toHaveLength(0);
  });

  it("filters by tag, project and done state", async () => {
    expect(await service.search({ tag: "docs" })).toHaveLength(1);
    expect(await service.search({ project: "web" })).toHaveLength(2);
    expect(await service.search({ done: false })).toHaveLength(3);
  });

  it("combines filters as AND", async () => {
    expect(await service.search({ project: "web", tag: "bug" })).toHaveLength(1);
    expect(await service.search({ project: "db", tag: "bug" })).toHaveLength(0);
  });

  it("returns newest first and honours the limit", async () => {
    const found = await service.search({ limit: 2 });
    expect(found).toHaveLength(2);
    expect(found[0]!.createdAt >= found[1]!.createdAt).toBe(true);
  });
});

describe("tag aggregation", () => {
  it("counts tag usage in the database and sorts by frequency", async () => {
    await service.add({ text: "a", tags: ["bug"] });
    await service.add({ text: "b", tags: ["bug", "auth"] });

    expect(await service.tags()).toEqual([
      { tag: "bug", count: 2 },
      { tag: "auth", count: 1 },
    ]);
  });

  it("returns an empty array when nothing is tagged", async () => {
    await service.add({ text: "untagged" });
    expect(await service.tags()).toEqual([]);
  });
});
