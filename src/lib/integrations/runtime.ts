import type { Database } from "@/lib/db/client";
import { logger } from "@/lib/logger";
import { channelModes, createTransports, type Transports } from "@/lib/notifications/transports";
import type { NotificationChannels } from "@/lib/notifications/types";
import type { SealingKey } from "./crypto";
import { loadStored, openStored, type Unreadable, type WebhookSettings } from "./store";

/*
 * The worker's view of Admin › Integrations. It reads the settings again
 * before each round of sending (every few seconds), so a change on the page
 * or with `cli settings` takes effect without a restart. Transports are
 * rebuilt only when the stored settings changed.
 *
 * Without BETTER_AUTH_SECRET (a worker started without it) the worker cannot
 * open the stored secrets. It reports that
 * in its heartbeat so the admin page can say so.
 */

export interface IntegrationsRuntime {
  /** The transports for the current settings. */
  transports(): Promise<Transports>;
  /** The webhook's URL and secret, or null while it is off. */
  webhook(): Promise<WebhookSettings | null>;
  /** What the heartbeat reports: the modes after the last read, and whether the key is missing. */
  channels(): NotificationChannels;
}

interface Current {
  stamp: string;
  transports: Transports;
  webhook: WebhookSettings | null;
}

export function createIntegrationsRuntime(options: {
  db: () => Database;
  key: SealingKey | null;
  mode: "live" | "console";
  baseUrl: string;
}): IntegrationsRuntime {
  let current: Current | undefined;
  const reported = new Set<Unreadable>();

  async function load(): Promise<Current> {
    const { stored } = await loadStored(options.db());
    const stamp = JSON.stringify(stored);
    if (current?.stamp === stamp) return current;
    const { integrations, unreadable } = openStored(stored, options.key);
    const { slack, email, webhook } = integrations;
    for (const field of unreadable) {
      if (reported.has(field)) continue;
      reported.add(field);
      logger.warn(
        { field },
        options.key
          ? "a secret of Admin › Integrations cannot be read with the current BETTER_AUTH_SECRET: enter it again"
          : "the worker has no BETTER_AUTH_SECRET, so it cannot read the secrets of Admin › Integrations: pass it to the worker, as compose.yaml does",
      );
    }
    current = {
      stamp,
      transports: createTransports({
        mode: options.mode,
        baseUrl: options.baseUrl,
        slack,
        email,
        unreadable,
      }),
      webhook: webhook.url && webhook.secret ? webhook : null,
    };
    return current;
  }

  return {
    transports: async () => (await load()).transports,
    webhook: async () => (await load()).webhook,
    channels() {
      const modes = current
        ? channelModes(current.transports)
        : { slack: "off" as const, slackChannel: "off" as const, email: "off" as const };
      return {
        ...modes,
        webhook: current?.webhook ? "live" : "off",
        withoutKey: !options.key,
      };
    },
  };
}
