import type { AiProvider } from "./ai/provider";

/** Private file storage for documents (implemented by src/local/file-store.ts). */
export interface FileStore {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream } | null>;
  delete(key: string): Promise<void>;
}

/** Everything the app needs from its runtime. Assembled by src/local/runtime.ts. */
export interface AppEnv {
  DB: D1Database;
  FILES?: FileStore;

  APP_ENV: string; // local | development | test
  AUTH_MODE: string; // local
  /** Email of the single local user (the owner of the local database). */
  LOCAL_USER_EMAIL?: string;
  /** "claude_code" | "none". AI only runs for extractions the user explicitly started with AI. */
  AI_PROVIDER?: string;
  /** Provider instance (Claude Code CLI), injected by the runtime. */
  AI_LOCAL?: AiProvider;
  AI_MODEL?: string;
  /** Hands an extraction to the in-process background task runner. */
  EXTRACTION_DISPATCH?: (msg: ExtractionMessage) => Promise<void>;
  /** Local Playwright application worker (absent when automation is unavailable). */
  APPLY?: ApplyController;
  MAX_UPLOAD_BYTES?: string;
  /** "read_only" rejects all writes (e.g. while restoring). */
  MAINTENANCE_MODE?: string;
}

export interface ExtractionMessage {
  extractionId: string;
  userId: string;
}

export interface CurrentUser {
  id: string;
  email: string;
}

export type HonoEnv = {
  Bindings: AppEnv;
  Variables: { user: CurrentUser; requestId: string };
};

export interface ApplyController {
  enqueue(attemptId: string): void;
  /** Stops a running attempt as soon as it is safe (never after Submit was clicked). */
  cancel(attemptId: string): void;
  status(): { available: boolean; browser: string | null; reason: string | null };
  /** A local screenshot taken during the attempt (PNG), or null. */
  readEvidence(attemptId: string, name: string): Uint8Array | null;
  /** Test/dev instances may target synthetic forms on 127.0.0.1; the personal instance never does. */
  allowLoopback: boolean;
}
