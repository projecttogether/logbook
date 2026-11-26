import { inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Transaction } from "@/lib/db/client";
import { appSetting } from "@/lib/db/schema";
import { open, SealedValueError, type SealingKey } from "./crypto";
import {
  EMAIL_PROVIDERS,
  INTEGRATION_NAMES,
  SMTP_SECURITY,
  type EmailProvider,
  type IntegrationName,
  type SmtpSecurity,
} from "./schemas";

/*
 * The integrations as rows of `app_setting` (keys `slack`, `email`,
 * `webhook`), with every secret sealed (crypto.ts) next to its hint. A row
 * exists once the setting was saved, also when it is off.
 */

/** A sealed secret and the hint the page shows. */
export interface Sealed {
  sealed: string;
  hint: string | null;
}

export interface StoredSlack {
  botToken: Sealed | null;
  channelId: string | null;
}

export interface StoredEmail {
  provider: EmailProvider;
  fromAddress: string;
  fromName: string;
  smtp: { host: string; port: number; security: SmtpSecurity; username: string; password: Sealed | null };
  mailersend: { token: Sealed | null };
}

export interface StoredWebhook {
  /** Plain text as an earlier version saved it, until a process seals it at its start (start.ts). */
  url: Sealed | string | null;
  secret: Sealed | null;
}

export interface StoredIntegrations {
  slack: StoredSlack;
  email: StoredEmail;
  webhook: StoredWebhook;
}

/** The settings with their secrets opened, for the worker and the tests. */
export interface SlackSettings {
  botToken: string | null;
  channelId: string | null;
}

export interface EmailSettings {
  provider: EmailProvider;
  fromAddress: string;
  fromName: string;
  smtp: { host: string; port: number; security: SmtpSecurity; username: string; password: string | null };
  mailersendToken: string | null;
}

export interface WebhookSettings {
  url: string | null;
  secret: string | null;
}

export interface Integrations {
  slack: SlackSettings;
  email: EmailSettings;
  webhook: WebhookSettings;
}

export const EMPTY: StoredIntegrations = {
  slack: { botToken: null, channelId: null },
  email: {
    provider: "none",
    fromAddress: "",
    fromName: "",
    smtp: { host: "", port: 587, security: "starttls", username: "", password: null },
    mailersend: { token: null },
  },
  webhook: { url: null, secret: null },
};

const sealedSchema = z.object({ sealed: z.string(), hint: z.string().nullable() }).nullable().catch(null);

const STORED_SCHEMAS = {
  slack: z.object({
    botToken: sealedSchema,
    channelId: z.string().nullable().catch(null),
  }),
  email: z.object({
    provider: z.enum(EMAIL_PROVIDERS).catch("none"),
    fromAddress: z.string().catch(""),
    fromName: z.string().catch(""),
    smtp: z
      .object({
        host: z.string().catch(""),
        port: z.number().int().catch(587),
        security: z.enum(SMTP_SECURITY).catch("starttls"),
        username: z.string().catch(""),
        password: sealedSchema,
      })
      .catch(EMPTY.email.smtp),
    mailersend: z.object({ token: sealedSchema }).catch({ token: null }),
  }),
  webhook: z.object({
    url: z.union([z.string(), sealedSchema]),
    secret: sealedSchema,
  }),
} as const;

export interface LoadedIntegrations {
  stored: StoredIntegrations;
}

/**
 * Makes writers wait for each other, also while a setting has no row yet
 * (FOR UPDATE locks only existing rows).
 */
export async function lockIntegrations(tx: Transaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('logbook.integrations'))`);
}

/** Reads the three rows. Writers call `lockIntegrations` in their transaction first. */
export async function loadStored(db: Database | Transaction): Promise<LoadedIntegrations> {
  const rows = await db
    .select({ key: appSetting.key, value: appSetting.value })
    .from(appSetting)
    .where(inArray(appSetting.key, [...INTEGRATION_NAMES]));
  const stored = structuredClone(EMPTY);
  for (const row of rows) {
    const name = row.key as IntegrationName;
    const parsed = STORED_SCHEMAS[name].safeParse(row.value);
    if (!parsed.success) continue;
    // A copy: fallbacks of the schema are shared objects.
    (stored as Record<IntegrationName, unknown>)[name] = structuredClone(parsed.data);
  }
  return { stored };
}

/** Saves one setting's row. `updatedById` is the admin, or null for the operator. */
export async function writeStored<N extends IntegrationName>(
  tx: Transaction,
  name: N,
  value: StoredIntegrations[N],
  updatedById: string | null,
): Promise<void> {
  await tx
    .insert(appSetting)
    .values({ key: name, value, updatedById })
    .onConflictDoUpdate({ target: appSetting.key, set: { value, updatedById, updatedAt: new Date() } });
}

/** The field a secret is sealed for, e.g. "slack.botToken". */
export const SECRET_FIELDS = {
  slackBotToken: "slack.botToken",
  smtpPassword: "email.smtp.password",
  mailerSendToken: "email.mailersend.token",
  webhookUrl: "webhook.url",
  webhookSecret: "webhook.secret",
} as const;

/** Secrets that cannot be opened with the key at hand, by field. */
export type Unreadable = (typeof SECRET_FIELDS)[keyof typeof SECRET_FIELDS];

/**
 * Opens the secrets. Without a key, or when a secret cannot be opened (a
 * changed BETTER_AUTH_SECRET), that secret counts as missing and its field
 * is listed in `unreadable`.
 */
export function openStored(
  stored: StoredIntegrations,
  key: SealingKey | null,
): { integrations: Integrations; unreadable: Unreadable[] } {
  const unreadable: Unreadable[] = [];
  const reveal = (field: Unreadable, value: Sealed | string | null): string | null => {
    if (value === null || typeof value === "string") return value;
    if (!key) {
      unreadable.push(field);
      return null;
    }
    try {
      return open(key, field, value.sealed);
    } catch (error) {
      if (!(error instanceof SealedValueError)) throw error;
      unreadable.push(field);
      return null;
    }
  };
  return {
    integrations: {
      slack: {
        botToken: reveal(SECRET_FIELDS.slackBotToken, stored.slack.botToken),
        channelId: stored.slack.channelId,
      },
      email: {
        provider: stored.email.provider,
        fromAddress: stored.email.fromAddress,
        fromName: stored.email.fromName,
        smtp: {
          ...stored.email.smtp,
          password: reveal(SECRET_FIELDS.smtpPassword, stored.email.smtp.password),
        },
        mailersendToken: reveal(SECRET_FIELDS.mailerSendToken, stored.email.mailersend.token),
      },
      webhook: {
        url: reveal(SECRET_FIELDS.webhookUrl, stored.webhook.url),
        secret: reveal(SECRET_FIELDS.webhookSecret, stored.webhook.secret),
      },
    },
    unreadable,
  };
}
