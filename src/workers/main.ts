import { hostname } from "node:os";
import * as Sentry from "@sentry/node";
import { PgBoss } from "pg-boss";
import {
  getDatabaseConfig,
  getErrorReportingConfig,
  getNotificationConfig,
  validateWorkerConfig,
} from "@/lib/config";
import { getDb, getPool } from "@/lib/db/client";
import { createOutageWatch, waitForDatabase } from "@/lib/db/outage";
import { envValue } from "@/lib/env";
import { sentryOptions } from "@/lib/error-reporting";
import { getDirectory } from "@/lib/directory/directory";
import type { SyncTrigger } from "@/lib/directory/sync";
import { SERVER_TIME_ZONE } from "@/lib/format";
import {
  DIRECTORY_SYNC_CRON,
  DISPATCH_INTERVAL_MS,
  PROPOSAL_WATCH_CRON,
  QUEUES,
  REMINDERS_CRON,
} from "@/lib/jobs/queues";
import { createIntegrationsRuntime } from "@/lib/integrations/runtime";
import { currentSealingKey } from "@/lib/integrations/service";
import { sealWebhookUrl } from "@/lib/integrations/start";
import { logger } from "@/lib/logger";
import { retrySlackLookups, startDispatcher } from "@/lib/notifications/dispatch";
import { notifyLostAccess, recordReminders } from "@/lib/notifications/notify";
import { refreshReadiness } from "@/lib/process/commands";
import { handleBossErrors } from "./boss-errors";
import { DEFAULT_HEARTBEAT_FILE, startHeartbeat } from "./heartbeat";
import { setUpWebhookJobs } from "./webhook-jobs";

interface DirectorySyncJob {
  trigger?: SyncTrigger;
}

async function main() {
  validateWorkerConfig();
  const sentry = sentryOptions(getErrorReportingConfig(), "worker");
  // The bundle has no node_modules to hook into at load time.
  if (sentry) Sentry.init({ ...sentry, enableRuntimeChannelInjection: false });
  // A restart of PostgreSQL is a warning; only a database that stays
  // unreachable goes to Sentry.
  const outage = createOutageWatch({ report: (error) => Sentry.captureException(error) });
  await waitForDatabase(() => getPool().query("select 1"), outage);
  const boss = new PgBoss({
    connectionString: getDatabaseConfig().DATABASE_URL,
    application_name: "logbook-worker-pgboss",
  });
  handleBossErrors(boss, outage, (error) => Sentry.captureException(error));
  await boss.start();

  // Set by the stop (SIGTERM, a deploy): the loops below finish the item at
  // hand and take no new one, so that nothing they send is cut off halfway.
  let stopping = false;
  const isStopping = () => stopping;

  // Slack, email, and the webhook come from Admin › Integrations.
  const key = currentSealingKey();
  if (key) await sealWebhookUrl(getDb(), key);
  const notificationConfig = getNotificationConfig();
  const integrations = createIntegrationsRuntime({
    db: getDb,
    key,
    mode: notificationConfig.NOTIFICATION_TRANSPORT,
    baseUrl: notificationConfig.LOGBOOK_BASE_URL,
  });

  // The Keycloak directory syncs every 15 minutes and once at startup, so a
  // fresh deployment has people right away. pg-boss keeps schedules in the
  // database, so the manual directory removes the schedule.
  const directory = getDirectory();
  const sync = directory.sync;
  if (sync) {
    await boss.createQueue(QUEUES.directorySync, { retryLimit: 2, retryDelay: 60, expireInSeconds: 300 });
    await boss.schedule(
      QUEUES.directorySync,
      DIRECTORY_SYNC_CRON,
      { trigger: "schedule" },
      { tz: SERVER_TIME_ZONE },
    );
    await boss.work<DirectorySyncJob>(QUEUES.directorySync, async (jobs) => {
      for (const job of jobs) {
        const result = await sync.run(job.data?.trigger ?? "schedule");
        // A failed run is already recorded; failing the job lets pg-boss retry.
        if (result.status === "failed") throw new Error(result.error);
      }
    });
    await boss.send(QUEUES.directorySync, { trigger: "startup" });
  } else {
    await boss.unschedule(QUEUES.directorySync);
    if (await boss.getQueue(QUEUES.directorySync)) await boss.deleteQueuedJobs(QUEUES.directorySync);
  }

  // Notifications: readiness, lost access, and due Slack lookups every few
  // minutes, reminders at 09:00 on working days. Delivery keys make repeated
  // runs harmless, so the reminder job also runs once at startup.
  await boss.createQueue(QUEUES.proposalWatch, { retryLimit: 1, retryDelay: 60, expireInSeconds: 240 });
  await boss.schedule(QUEUES.proposalWatch, PROPOSAL_WATCH_CRON, {}, { tz: SERVER_TIME_ZONE });
  await boss.work(QUEUES.proposalWatch, async () => {
    await refreshReadiness(getDb(), new Date());
    await notifyLostAccess(getDb(), new Date());
    await retrySlackLookups(getDb(), await integrations.transports(), new Date(), isStopping);
  });
  await boss.createQueue(QUEUES.reminders, { retryLimit: 3, retryDelay: 300, expireInSeconds: 600 });
  await boss.schedule(QUEUES.reminders, REMINDERS_CRON, {}, { tz: SERVER_TIME_ZONE });
  await boss.work(QUEUES.reminders, async () => {
    const recorded = await recordReminders(getDb(), new Date());
    if (recorded > 0) logger.info({ recorded }, "reminders recorded");
  });
  await boss.send(QUEUES.reminders, {});

  await setUpWebhookJobs(boss, {
    webhook: integrations.webhook,
    baseUrl: notificationConfig.LOGBOOK_BASE_URL,
    db: getDb,
    stopping: isStopping,
  });

  const stopDispatcher = startDispatcher({
    db: getDb(),
    transports: integrations.transports,
    intervalMs: DISPATCH_INTERVAL_MS,
    outage,
  });

  const stopHeartbeat = startHeartbeat({
    db: getDb(),
    workerId: hostname(),
    file: envValue("WORKER_HEARTBEAT_FILE") ?? DEFAULT_HEARTBEAT_FILE,
    channels: integrations.channels,
    outage,
  });
  logger.info({ directory: directory.kind, channels: integrations.channels() }, "worker started");

  // A stop tells every loop at once, then waits for the items at hand: the
  // message and the webhook delivery being sent. Each is recorded when it is
  // done, so nothing is sent twice or dropped.
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "worker stopping");
    stopHeartbeat();
    await Promise.all([stopDispatcher(), boss.stop({ graceful: true, timeout: 45_000 })]);
    await getPool().end();
    logger.info("worker stopped");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch(async (error: unknown) => {
  logger.fatal({ err: error }, "worker failed to start");
  Sentry.captureException(error);
  await Sentry.flush(2_000);
  process.exit(1);
});
