// In-process background extraction.
//
// The job row is always saved first; the `job_extraction_jobs` row IS the durable queue entry.
// This runner only decides *when* to work on it:
//   - new extractions run immediately (2 at a time)
//   - transient failures (timeouts, 5xx, 429) retry with backoff, up to 3 attempts in total
//   - on startup, extractions interrupted by a quit/crash/sleep are picked up again
// Nothing runs while the app is closed, and no extra service is installed.
import type { AppEnv, ExtractionMessage } from "../server/env";
import type { PipelineDeps } from "../server/extraction/pipeline";
import { processExtraction, RetryableExtractionError } from "../server/services/extractions";

const MAX_ATTEMPTS = 3;
const RECOVER_WINDOW_MS = 24 * 3600_000;

export interface TaskRunner {
  dispatch(msg: ExtractionMessage): Promise<void>;
  recover(): Promise<number>;
  idle(): Promise<void>;
  stop(): void;
  stats(): { running: number; queued: number; retrying: number };
}

export function createTaskRunner(getEnv: () => AppEnv, opts: { concurrency?: number; deps?: () => PipelineDeps; retryDelayMs?: (attempt: number) => number } = {}): TaskRunner {
  const concurrency = opts.concurrency ?? 2;
  const retryDelay = opts.retryDelayMs ?? ((a: number) => Math.min(60, 10 * a) * 1000);
  const queue: { id: string; attempt: number }[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const active = new Set<string>();
  let running = 0;
  let stopped = false;
  let waiters: (() => void)[] = [];

  const settle = () => {
    if (running === 0 && queue.length === 0 && timers.size === 0) {
      for (const w of waiters) w();
      waiters = [];
    }
  };

  const pump = () => {
    while (!stopped && running < concurrency && queue.length) {
      const job = queue.shift()!;
      if (active.has(job.id)) continue;
      active.add(job.id);
      running++;
      void (async () => {
        try {
          await processExtraction(getEnv(), job.id, job.attempt, opts.deps?.());
        } catch (e) {
          if (e instanceof RetryableExtractionError && job.attempt < MAX_ATTEMPTS && !stopped) {
            const t = setTimeout(() => {
              timers.delete(t);
              queue.push({ id: job.id, attempt: job.attempt + 1 });
              pump();
            }, retryDelay(job.attempt));
            timers.add(t);
          } else if (!(e instanceof RetryableExtractionError)) {
            // Error class only — never the JD, URL or SQL parameters.
            console.error(JSON.stringify({ level: "error", where: "tasks", error: (e as Error)?.name }));
          }
        } finally {
          active.delete(job.id);
          running--;
          pump();
          settle();
        }
      })();
    }
    settle();
  };

  return {
    async dispatch(msg) {
      queue.push({ id: msg.extractionId, attempt: 1 });
      pump();
    },
    async recover() {
      const env = getEnv();
      const since = Date.now() - RECOVER_WINDOW_MS;
      const rows = await env.DB.prepare(
        "SELECT id, attempts FROM job_extraction_jobs WHERE status IN ('queued','fetching','extracting') AND dismissed_at IS NULL AND created_at >= ? ORDER BY created_at",
      )
        .bind(since)
        .all<{ id: string; attempts: number }>();
      for (const r of rows.results) queue.push({ id: r.id, attempt: Math.min(MAX_ATTEMPTS, Number(r.attempts) + 1) });
      pump();
      return rows.results.length;
    },
    idle() {
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
        settle();
      });
    },
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      queue.length = 0;
      settle();
    },
    stats: () => ({ running, queued: queue.length, retrying: timers.size }),
  };
}
