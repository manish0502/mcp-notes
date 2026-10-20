import { z } from "zod";

/**
 * Input schemas, one per tool.
 *
 * The SDK takes a plain object of Zod validators (a "raw shape"), converts it to JSON
 * Schema for tools/list, AND validates incoming arguments before your handler runs. So
 * every .describe() here is read by the model, and every constraint is enforced for
 * free — you never hand-validate tool arguments.
 */

export const addNoteShape = {
  text: z.string().min(1).max(2_000).describe("The note content"),
  tags: z.array(z.string()).optional().describe("Labels, e.g. ['bug', 'auth']"),
  project: z.string().optional().describe("Project this note belongs to"),
};

export const searchNotesShape = {
  text: z.string().optional().describe("Case-insensitive substring to find in note text"),
  tag: z.string().optional().describe("Only notes carrying this tag"),
  project: z.string().optional().describe("Only notes for this project"),
  done: z.boolean().optional().describe("Filter by completion state"),
  limit: z.number().int().min(1).max(200).optional().describe("Max results, default 50"),
};

export const updateNoteShape = {
  id: z.string().describe("The note id returned by add_note or search_notes"),
  text: z.string().min(1).max(2_000).optional().describe("Replacement text"),
  tags: z.array(z.string()).optional().describe("Replacement tags (replaces, not merges)"),
  project: z.string().optional().describe("Replacement project"),
  done: z.boolean().optional().describe("Mark complete or incomplete"),
};

export const deleteNoteShape = {
  id: z.string().describe("The note id to delete permanently"),
};

/**
 * Prompt arguments are a different beast: MCP transmits them as STRINGS only. A
 * z.number() or z.boolean() here would be wrong, which is why this shape is separate
 * rather than reusing searchNotesShape.
 */
export const reviewPromptShape = {
  project: z.string().optional().describe("Limit the review to one project"),
  tag: z.string().optional().describe("Limit the review to one tag"),
};
