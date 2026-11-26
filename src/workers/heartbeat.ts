import { writeFile } from "node:fs/promises";
import type { Database } from "@/lib/db/client";
import type { OutageWatch } from "@/lib/db/outage";
import { workerHeartbeat } from "@/lib/db/schema";
import type { NotificationChannels } from "@/lib/notifications/types";
import { errorMessage, logger } from "@/lib/logger";

import { HEARTBEAT_INTERVAL_MS } from "./heartbeat-file";

export { DEFAULT_HEARTBEAT_FILE, HEARTBEAT_INTERVAL_MS } from "./heartbeat-file";

/**
 * Writes a heartbeat every 30 seconds: to a file, which the container health
 * check reads, and to the database, which the admin page shows. Its write
 * tells the outage watch whether the database answers.
 */
export function startHeartbeat(options: {
  db: Database;
  workerId: string;
  file: string;
  /** What the worker reports about its channels, read at each beat. */
  channels: () => NotificationChannels;
  outage: OutageWatch;
}): () => void {
  const startedAt = new Date();

  async function beat() {
    const now = new Date();
    try {
      await writeFile(options.file, now.toISOString());
    } catch (error) {
      logger.warn({ error: errorMessage(error) }, "could not write the heartbeat file");
    }
    try {
      const channels = options.channels();
      await options.db
        .insert(workerHeartbeat)
        .values({ workerId: options.workerId, startedAt, beatAt: now, channels })
        .onConflictDoUpdate({ target: workerHeartbeat.workerId, set: { startedAt, beatAt: now, channels } });
      options.outage.answered();
    } catch (error) {
      if (!options.outage.failed(error, "heartbeat")) {
        logger.warn({ error: errorMessage(error) }, "could not write the heartbeat to the database");
      }
    }
  }

  void beat();
  const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(timer);
}
