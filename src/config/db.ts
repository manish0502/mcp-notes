import mongoose from "mongoose";

/**
 * Mongoose connection management. One place that knows the URI, so nothing else does.
 */

export const MONGODB_URI =
  process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/mcp_notes";

export async function connectDb(uri: string = MONGODB_URI): Promise<void> {
  if (mongoose.connection.readyState === 1) return;

  await mongoose.connect(uri, {
    // Fail fast instead of hanging: an MCP client waiting on initialize has no idea
    // the server is stuck on a database it will never reach.
    serverSelectionTimeoutMS: 5_000,
  });
}

export async function disconnectDb(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
}

export function isConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
