import type { PgBoss } from "pg-boss";
import type { OutageWatch } from "@/lib/db/outage";
import { asError } from "@/lib/error-reporting";
import { errorMessage, logger } from "@/lib/logger";

/**
 * pg-boss emits `error` for its pool's idle connections, its polls, and its
 * maintenance, and retries all of them itself. A connection error, as while
 * PostgreSQL restarts, goes to the outage watch; any other error is reported.
 * A job whose completion failed with the connection stays active until it
 * expires; pg-boss then retries it within its queue's retry limit, and the
 * schedules start every job again anyway.
 */
export function handleBossErrors(
  boss: Pick<PgBoss, "on">,
  outage: OutageWatch,
  report: (error: unknown) => void,
): void {
  boss.on("error", (error) => {
    // Classified before asError, which keeps only message and stack.
    if (outage.failed(error, "pg-boss")) return;
    // pg-boss errors can carry a PostgreSQL client or bound query values.
    const exception = asError(error);
    logger.error({ error: errorMessage(exception) }, "pg-boss error");
    report(exception);
  });
}
