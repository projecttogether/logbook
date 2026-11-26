import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/lib/db/client";
import { appSetting } from "@/lib/db/schema";
import { errorMessage, logger } from "@/lib/logger";
import { seal, urlHint, type SealingKey } from "./crypto";
import { currentSealingKey } from "./service";
import { loadStored, lockIntegrations, SECRET_FIELDS } from "./store";

/** Seals a webhook URL that an earlier version saved as plain text. Returns whether there was one. */
export async function sealWebhookUrl(db: Database, key: SealingKey): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockIntegrations(tx);
    const { webhook } = (await loadStored(tx)).stored;
    if (typeof webhook.url !== "string") return false;
    const url = { sealed: seal(key, SECRET_FIELDS.webhookUrl, webhook.url), hint: urlHint(webhook.url) };
    await tx
      .update(appSetting)
      .set({ value: { ...webhook, url } })
      .where(eq(appSetting.key, "webhook"));
    logger.info("the saved webhook URL is now encrypted");
    return true;
  });
}

/** For the web process. A failure is only logged: the worker seals it too, or does not start. */
export async function sealAtStart(): Promise<void> {
  try {
    const key = currentSealingKey();
    if (key) await sealWebhookUrl(getDb(), key);
  } catch (error) {
    logger.warn({ error: errorMessage(error) }, "could not encrypt the saved webhook URL");
  }
}
