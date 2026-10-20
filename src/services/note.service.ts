import mongoose from "mongoose";

import { NoteModel, toNote, type Note, type NoteDocument } from "../models/note.model.js";

/**
 * Business logic. Knows about MongoDB, knows nothing about MCP.
 *
 * Every method that takes an id tolerates garbage: a malformed ObjectId returns null
 * rather than throwing, because the id came from a language model and will sometimes be
 * invented.
 */

export interface NewNote {
  text: string;
  tags?: string[];
  project?: string | null;
}

export interface NotePatch {
  text?: string;
  tags?: string[];
  project?: string | null;
  done?: boolean;
}

export interface SearchQuery {
  text?: string;
  tag?: string;
  project?: string;
  done?: boolean;
  limit?: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

export class NoteService {
  async add(input: NewNote): Promise<Note> {
    const created = await NoteModel.create({
      text: input.text,
      tags: input.tags ?? [],
      project: input.project ?? null,
      done: false,
    });
    return toNote(created as NoteDocument);
  }

  async get(id: string): Promise<Note | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const found = await NoteModel.findById(id);
    return found === null ? null : toNote(found as NoteDocument);
  }

  async all(limit = 200): Promise<Note[]> {
    const docs = await NoteModel.find().sort({ createdAt: -1 }).limit(limit);
    return docs.map((doc) => toNote(doc as NoteDocument));
  }

  async update(id: string, patch: NotePatch): Promise<Note | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    // Build the update from only the provided fields, so a patch never nulls a field
    // the caller did not mention.
    const changes: Record<string, unknown> = {};
    if (patch.text !== undefined) changes.text = patch.text;
    if (patch.tags !== undefined) changes.tags = patch.tags;
    if (patch.project !== undefined) changes.project = patch.project;
    if (patch.done !== undefined) changes.done = patch.done;

    if (Object.keys(changes).length === 0) return this.get(id);

    const updated = await NoteModel.findByIdAndUpdate(
      id,
      { $set: changes },
      // returnDocument: "after" gives the UPDATED document. Without it you get the stale
      // one, which is the classic findByIdAndUpdate bug. (The old `new: true` spelling is
      // deprecated in Mongoose 9.)
      { returnDocument: "after", runValidators: true },
    );

    return updated === null ? null : toNote(updated as NoteDocument);
  }

  async remove(id: string): Promise<Note | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const removed = await NoteModel.findByIdAndDelete(id);
    return removed === null ? null : toNote(removed as NoteDocument);
  }

  async search(query: SearchQuery): Promise<Note[]> {
    // Mongoose 9 no longer exports FilterQuery, so this is a plain record.
    const filter: Record<string, unknown> = {};

    if (query.text !== undefined && query.text.length > 0) {
      // Substring, case-insensitive. A $text index would be faster but matches whole
      // words only, which is wrong for searching notes.
      filter.text = { $regex: escapeRegex(query.text), $options: "i" };
    }
    if (query.tag !== undefined) filter.tags = query.tag.trim().toLowerCase();
    if (query.project !== undefined) filter.project = query.project;
    if (query.done !== undefined) filter.done = query.done;

    const docs = await NoteModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(query.limit ?? 50);

    return docs.map((doc) => toNote(doc as NoteDocument));
  }

  /** Tag frequencies, computed in the database rather than in Node. */
  async tags(): Promise<TagCount[]> {
    return NoteModel.aggregate<TagCount>([
      { $unwind: "$tags" },
      { $group: { _id: "$tags", count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $project: { _id: 0, tag: "$_id", count: 1 } },
    ]);
  }
}

/** User input goes into a regex, so metacharacters must be neutralised. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
