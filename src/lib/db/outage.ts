import { asError } from "@/lib/error-reporting";
import { logger } from "@/lib/logger";

/*
 * A restart of PostgreSQL, such as one for an upgrade, drops every connection and
 * refuses new ones for a few seconds. The worker's loops retry on their own,
 * so such an error is a warning; only a database that stays unreachable is
 * an error to report.
 */

/**
 * SQLSTATEs of a server that stops, crashed, or is not ready yet:
 * admin_shutdown ("terminating connection due to administrator command"),
 * crash_shutdown, and cannot_connect_now ("the database system is starting
 * up" or "shutting down"). Class 08 is a connection exception, except
 * 08P01, a protocol violation.
 */
const RESTART_SQLSTATES = new Set(["57P01", "57P02", "57P03"]);

/** Socket errors while the server is down; without its container, Docker's DNS knows no host. */
const SOCKET_ERRORS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/**
 * Errors pg and pg-pool raise without a code. Prefixes, because pg-boss
 * appends the queue and worker to the message.
 */
const CONNECTION_MESSAGES = [
  "Connection terminated unexpectedly",
  "Connection terminated due to connection timeout",
  "timeout exceeded when trying to connect",
  "Client has encountered a connection error and is not queryable",
];

/**
 * The error means PostgreSQL could not be reached or dropped the connection,
 * as during a restart. Anything else, such as bad SQL, a violated
 * constraint, or a bug, is not. Follows `cause`, since Drizzle wraps the
 * driver's error. pg-boss emits some errors as plain objects with the
 * original's fields, so this reads fields instead of checking classes.
 */
export function isConnectionError(error: unknown): boolean {
  return connectionCause(error) !== undefined;
}

/** The connection error in `error` or its causes; it names the reason, unlike Drizzle's "Failed query". */
function connectionCause(error: unknown): object | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const { code, message, cause } = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof code === "string") {
      if (RESTART_SQLSTATES.has(code) || SOCKET_ERRORS.has(code)) return current;
      if (code.startsWith("08") && code !== "08P01") return current;
    }
    if (typeof message === "string" && CONNECTION_MESSAGES.some((prefix) => message.startsWith(prefix)))
      return current;
    current = cause;
  }
  return undefined;
}

/**
 * Five minutes. A restart of PostgreSQL, also one for a new image, takes
 * seconds to a minute; five minutes leave room for a slow start, such as
 * crash recovery. Longer means the server is down or unreachable, and a
 * person has to look: jobs and notifications wait meanwhile.
 */
export const OUTAGE_REPORT_AFTER_MS = 5 * 60_000;

/** While the outage lasts, the warning repeats once a minute instead of on every retry. */
const REPEAT_WARNING_MS = 60_000;

/** What the worker reports once the database stays unreachable. */
export class DatabaseUnreachableError extends Error {
  override name = "DatabaseUnreachableError";
}

export interface OutageWatch {
  /**
   * Takes an error from a database call. A connection error is logged as a
   * warning and becomes an outage, reported once it lasts
   * `OUTAGE_REPORT_AFTER_MS`; returns true. Returns false for any other
   * error, which the caller handles as before.
   */
  failed(error: unknown, source: string): boolean;
  /** A database call succeeded: an outage, if any, is over. */
  answered(): void;
}

/** One per process: every loop that talks to the database tells it how the last call went. */
export function createOutageWatch(options: {
  report: (error: DatabaseUnreachableError) => void;
  now?: () => number;
  reportAfterMs?: number;
}): OutageWatch {
  const now = options.now ?? Date.now;
  const reportAfterMs = options.reportAfterMs ?? OUTAGE_REPORT_AFTER_MS;
  let outage: { since: number; warnedAt: number; reported: boolean } | undefined;

  return {
    failed(error, source) {
      const cause = connectionCause(error);
      if (!cause) return false;
      const at = now();
      const context = { source, err: cause };
      if (!outage) {
        outage = { since: at, warnedAt: at, reported: false };
        logger.warn(context, "database unreachable, retrying");
        return true;
      }
      const downSeconds = Math.round((at - outage.since) / 1_000);
      if (!outage.reported && at - outage.since >= reportAfterMs) {
        outage.reported = true;
        outage.warnedAt = at;
        logger.error({ ...context, downSeconds }, "database still unreachable, reporting");
        const minutes = Math.round(reportAfterMs / 60_000);
        // A fixed message, so that every outage is one issue in Sentry.
        options.report(
          new DatabaseUnreachableError(`PostgreSQL unreachable for ${minutes} minutes`, {
            cause: asError(cause),
          }),
        );
      } else if (at - outage.warnedAt >= REPEAT_WARNING_MS) {
        outage.warnedAt = at;
        logger.warn({ ...context, downSeconds }, "database still unreachable, retrying");
      }
      return true;
    },
    answered() {
      if (!outage) return;
      logger.info({ downSeconds: Math.round((now() - outage.since) / 1_000) }, "database reachable again");
      outage = undefined;
    },
  };
}

/**
 * Waits until the database answers `probe`, retrying connection errors with
 * a growing pause (1 to 30 seconds): a worker that starts while PostgreSQL
 * restarts, such as after a reboot of the server, waits instead of exiting.
 * Any other error throws.
 */
export async function waitForDatabase(
  probe: () => Promise<unknown>,
  watch: OutageWatch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await probe();
      watch.answered();
      return;
    } catch (error) {
      if (!watch.failed(error, "startup")) throw error;
      await sleep(Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000));
    }
  }
}
