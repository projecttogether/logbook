import { describe, expect, it } from "vitest";
import type { Database } from "@/lib/db/client";
import type { WebhookSettings } from "@/lib/integrations/store";
import { WEBHOOK_RECONCILE_CRON, WEBHOOK_SYNC_CRON } from "@/lib/jobs/queues";
import { setUpWebhookJobs } from "./webhook-jobs";

function fakeBoss() {
  const calls: string[] = [];
  const handlers = new Map<string, () => Promise<void>>();
  const boss = {
    createQueue: async (name: string) => void calls.push(`createQueue ${name}`),
    schedule: async (name: string, cron: string) => void calls.push(`schedule ${name} ${cron}`),
    work: async (name: string, handler: () => Promise<void>) => {
      calls.push(`work ${name}`);
      handlers.set(name, handler);
      return "worker-id";
    },
    send: async (name: string) => {
      calls.push(`send ${name}`);
      return "job-id";
    },
  };
  return { boss: boss as unknown as Parameters<typeof setUpWebhookJobs>[0], calls, handlers };
}

const ON: WebhookSettings = { url: "https://hooks.example.org/logbook", secret: "s".repeat(32) };

describe("webhook jobs in the worker", () => {
  it("schedule the minute sync and the nightly run, and reconcile once at startup", async () => {
    const { boss, calls } = fakeBoss();
    await setUpWebhookJobs(boss, {
      webhook: async () => ON,
      baseUrl: "https://logbook.example",
      db: () => ({}) as Database,
    });
    expect(calls).toEqual([
      "createQueue webhook-sync",
      `schedule webhook-sync ${WEBHOOK_SYNC_CRON}`,
      "work webhook-sync",
      "createQueue webhook-reconcile",
      `schedule webhook-reconcile ${WEBHOOK_RECONCILE_CRON}`,
      "work webhook-reconcile",
      "send webhook-reconcile",
    ]);
  });

  it("do nothing while the webhook is off, and catch up once it is turned on", async () => {
    let settings: WebhookSettings | null = null;
    let reads = 0;
    // The jobs reach the database only to send; this one stops them there.
    const db = () => {
      reads += 1;
      throw new Error("stop before sending");
    };
    const { boss, calls, handlers } = fakeBoss();
    await setUpWebhookJobs(boss, { webhook: async () => settings, baseUrl: "https://logbook.example", db });
    calls.length = 0;
    await handlers.get("webhook-sync")!();
    await handlers.get("webhook-reconcile")!();
    expect({ calls, reads }).toEqual({ calls: [], reads: 0 });

    // Turned on (on the page or with `cli settings`): the next sync asks for a reconciliation, then sends.
    settings = ON;
    await expect(handlers.get("webhook-sync")!()).rejects.toThrow("stop before sending");
    expect({ calls, reads }).toEqual({ calls: ["send webhook-reconcile"], reads: 1 });
  });
});
