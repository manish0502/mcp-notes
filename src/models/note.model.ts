import { Schema, model, type HydratedDocument } from "mongoose";

/**
 * The Mongoose model, plus the DTO the rest of the app speaks.
 *
 * Nothing outside this file sees a Mongoose document: `toNote()` converts to a plain
 * object with a string id. That keeps the service and MCP layers free of ODM types and
 * means swapping Mongoose out would touch exactly one file.
 */

export interface NoteAttrs {
  text: string;
  tags: string[];
  project: string | null;
  done: boolean;
}

/** What the MCP layer and tests work with. */
export interface Note {
  id: string;
  text: string;
  tags: string[];
  project: string | null;
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

const noteSchema = new Schema<NoteAttrs>(
  {
    text: { type: String, required: true, trim: true, maxlength: 2_000 },
    tags: {
      type: [String],
      default: [],
      // Normalising in the schema means every write path gets it, including bulk updates.
      set: (tags: string[]) => [
        ...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)),
      ],
      index: true,
    },
    project: { type: String, default: null, index: true },
    done: { type: Boolean, default: false, index: true },
  },
  {
    // Gives createdAt / updatedAt for free, maintained by Mongoose.
    timestamps: true,
    collection: "notes",
  },
);

export const NoteModel = model<NoteAttrs>("Note", noteSchema);

export type NoteDocument = HydratedDocument<NoteAttrs> & {
  createdAt: Date;
  updatedAt: Date;
};

export function toNote(doc: NoteDocument): Note {
  return {
    id: String(doc._id),
    text: doc.text,
    tags: doc.tags,
    project: doc.project,
    done: doc.done,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
