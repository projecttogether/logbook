import type { PgBoss } from "pg-boss";
import type { Database } from "@/lib/db/client";
import { SERVER_TIME_ZONE } from "@/lib/format";
import type { WebhookSettings } from "@/lib/integrations/store";
import { QUEUES, WEBHOOK_RECONCILE_CRON, WEBHOOK_SYNC_CRON } from "@/lib/jobs/queues";
import { neverStopping, type Stopping } from "@/lib/jobs/stopping";
import { logger } from "@/lib/logger";
import { createWebhookClient, type WebhookClient } from "@/lib/webhooks/client";
import { reconcileWebhook, syncRequested } from "@/lib/webhooks/sync";

type Boss = Pick<PgBoss, "createQueue" | "schedule" | "work" | "send">;

/**
 * Webhook jobs: requested entries every minute, every changed entry nightly,
 * once at startup, and whenever the webhook's URL changes (it was turned on,
 * or points to another receiver). Each run reads the webhook's settings
 * (Admin › Integrations); while it is off, runs do nothing and requests wait.
 * Once `stopping` says so, a run finishes the entry at hand and sends no other.
 */
export async function setUpWebhookJobs(
  boss: Boss,
  options: {
    webhook: () => Promise<WebhookSettings | null>;
    baseUrl: string;
    db: () => Database;
    createClient?: (config: Parameters<typeof createWebhookClient>[0]) => WebhookClient;
    stopping?: Stopping;
  },
): Promise<void> {
  const client = (settings: WebhookSettings) =>
    (options.createClient ?? createWebhookClient)({ url: settings.url!, secret: settings.secret! });
  const stopping = options.stopping ?? neverStopping;
  let seenUrl = (await options.webhook())?.url ?? null;

  await boss.createQueue(QUEUES.webhookSync, { retryLimit: 0, expireInSeconds: 300 });
  await boss.schedule(QUEUES.webhookSync, WEBHOOK_SYNC_CRON, {}, { tz: SERVER_TIME_ZONE });
  await boss.work(QUEUES.webhookSync, async () => {
    const settings = await options.webhook();
    const url = settings?.url ?? null;
    if (url !== seenUrl) {
      seenUrl = url;
      // The receiver may lack entries that changed while it was off.
      if (settings) await boss.send(QUEUES.webhookReconcile, {});
    }
    if (!settings) return;
    const counts = await syncRequested(
      options.db(),
      client(settings),
      options.baseUrl,
      new Date(),
      undefined,
      stopping,
    );
    if (counts.sent + counts.failed > 0) logger.info(counts, "webhook sync");
  });
  await boss.createQueue(QUEUES.webhookReconcile, { retryLimit: 2, retryDelay: 600, expireInSeconds: 3_600 });
  await boss.schedule(QUEUES.webhookReconcile, WEBHOOK_RECONCILE_CRON, {}, { tz: SERVER_TIME_ZONE });
  await boss.work(QUEUES.webhookReconcile, async () => {
    const settings = await options.webhook();
    if (!settings) return;
    logger.info(
      await reconcileWebhook(options.db(), client(settings), options.baseUrl, new Date(), stopping),
      "webhook reconciliation",
    );
  });
  await boss.send(QUEUES.webhookReconcile, {});
}
