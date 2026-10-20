import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Note } from "../models/note.model.js";
import type { NoteService } from "../services/note.service.js";
import {
  addNoteShape,
  deleteNoteShape,
  reviewPromptShape,
  searchNotesShape,
  updateNoteShape,
} from "./schemas.js";

/**
 * The MCP surface. Everything protocol-shaped lives here; all real work goes to the
 * service, which goes to Mongo.
 *
 * MCP has three primitives and the distinction matters:
 *
 *   TOOLS     — model-controlled. The model decides when to call them. All side effects
 *               live here; this is the only primitive that can change anything.
 *   RESOURCES — application-controlled. Read-only data addressed by URI, which the client
 *               attaches to context. The model does not "call" a resource.
 *   PROMPTS   — user-controlled. Reusable templates the user picks, usually surfaced as a
 *               slash command in the client.
 */
export function createNotesServer(service: NoteService): McpServer {
  const server = new McpServer({ name: "mcp-notes", version: "1.0.0" });

  // ─── TOOLS ───────────────────────────────────────────────────────────────────────
  //
  // `annotations` tell the client what a tool does. They are advisory, not enforced, but
  // clients use them to decide what needs human approval and what is safe to cache.
  // Omit them and every caller must assume the worst about your tool.

  server.registerTool(
    "add_note",
    {
      title: "Add note",
      description: "Capture a new note or TODO. Returns the created note with its id.",
      annotations: {
        readOnlyHint: false, // it writes
        destructiveHint: false, // but only ever inserts; nothing is lost
        idempotentHint: false, // calling twice creates two notes
      },
      inputSchema: addNoteShape,
    },
    async ({ text, tags, project }) => {
      const note = await service.add({ text, tags, project: project ?? null });
      return { content: [{ type: "text", text: `Added\n${format(note)}` }] };
    },
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Find notes by text, tag, project or completion state. With no filters, returns the most recent notes.",
      annotations: {
        readOnlyHint: true, // safe to call freely, safe to cache
        openWorldHint: false, // answers come only from the local database
      },
      inputSchema: searchNotesShape,
    },
    async (query) => {
      const found = await service.search(query);
      if (found.length === 0) return { content: [{ type: "text", text: "No notes matched." }] };

      return {
        content: [
          { type: "text", text: `${found.length} note(s):\n\n${found.map(format).join("\n\n")}` },
        ],
      };
    },
  );

  server.registerTool(
    "update_note",
    {
      title: "Update note",
      description:
        "Change a note's text, tags, project or completion state. Only the fields you pass are modified.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false, // overwrites fields, but the note survives
        idempotentHint: true, // the same patch twice leaves the same end state
      },
      inputSchema: updateNoteShape,
    },
    async ({ id, ...patch }) => {
      const updated = await service.update(id, patch);

      // A bad id is a normal outcome, not a crash. isError lets the model see and recover
      // from it; throwing would look like a server fault and may drop the connection.
      if (updated === null) return notFound(id);

      return { content: [{ type: "text", text: `Updated\n${format(updated)}` }] };
    },
  );

  server.registerTool(
    "delete_note",
    {
      title: "Delete note",
      description: "Permanently delete a note by id. This cannot be undone.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true, // the one tool a client should confirm before running
        idempotentHint: true, // deleting an already-deleted note changes nothing
      },
      inputSchema: deleteNoteShape,
    },
    async ({ id }) => {
      const removed = await service.remove(id);
      if (removed === null) return notFound(id);

      return { content: [{ type: "text", text: `Deleted ${removed.id}: ${removed.text}` }] };
    },
  );

  // ─── RESOURCES ───────────────────────────────────────────────────────────────────
  //
  // Addressed by URI, read via resources/read. The client decides when to pull these
  // into context, which is why they must be cheap and free of side effects.

  server.registerResource(
    "all-notes",
    "notes://all",
    {
      title: "All notes",
      description: "Every stored note as JSON. Useful as context for a review.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await service.all(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "tag-index",
    "notes://tags",
    {
      title: "Tag index",
      description: "Every tag in use with how many notes carry it.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await service.tags(), null, 2),
        },
      ],
    }),
  );

  // ─── PROMPTS ─────────────────────────────────────────────────────────────────────
  //
  // A template the USER invokes. Note it returns messages, not an answer: the prompt
  // seeds the conversation and the model does the work.

  server.registerPrompt(
    "review_open_notes",
    {
      title: "Review open notes",
      description: "Summarise outstanding notes and propose what to tackle next.",
      argsSchema: reviewPromptShape,
    },
    async (args) => {
      const open = await service.search({ ...args, done: false });

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                open.length === 0
                  ? "I have no open notes. Say so plainly."
                  : `Here are my open notes:\n\n${open.map(format).join("\n\n")}\n\n` +
                    `Group them by theme, flag anything stale or duplicated, and recommend ` +
                    `the three I should do first. Be direct.`,
            },
          },
        ],
      };
    },
  );

  return server;
}

function notFound(id: string) {
  return {
    content: [{ type: "text" as const, text: `No note with id ${id}.` }],
    isError: true,
  };
}

function format(note: Note): string {
  const lines = [`[${note.id}]${note.done ? " (done)" : ""} ${note.text}`];
  if (note.tags.length > 0) lines.push(`  tags: ${note.tags.join(", ")}`);
  if (note.project !== null) lines.push(`  project: ${note.project}`);
  lines.push(`  created: ${note.createdAt}`);
  return lines.join("\n");
}
