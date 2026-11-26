import { desc, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { auditActor, type SettingsActor } from "@/lib/audit/actor";
import { recordAudit } from "@/lib/audit";
import { parseNotificationModeConfig, parseSealingConfig } from "@/lib/config";
import type { Database } from "@/lib/db/client";
import { workerHeartbeat } from "@/lib/db/schema";
import { errorMessage } from "@/lib/logger";
import { createTransports, DeliveryError, emailReady, type Transports } from "@/lib/notifications/transports";
import { deriveSealingKey, seal, secretHint, urlHint, type SealingKey } from "./crypto";
import {
  emailTestSchema,
  fieldErrorsOf,
  INPUT_SCHEMAS,
  type EmailView,
  type IntegrationFieldErrors,
  type IntegrationName,
  type IntegrationState,
  type IntegrationViews,
  type SlackView,
  type SmtpSecurity,
  type TestResult,
  type WebhookView,
} from "./schemas";
import {
  loadStored,
  lockIntegrations,
  openStored,
  SECRET_FIELDS,
  writeStored,
  type Sealed,
  type StoredEmail,
  type StoredIntegrations,
  type StoredSlack,
  type StoredWebhook,
  type Unreadable,
} from "./store";

/*
 * Admin › Integrations: Slack, email, and the webhook. The page's Server
 * Actions and `cli settings` call these functions, so both run the same
 * checks, seal secrets the same way, and write the same audit events. Only
 * the worker sends; it reads these settings while it runs (runtime.ts).
 */

/** The app refuses a body: the message, and a message per field. */
export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly fieldErrors: IntegrationFieldErrors = {},
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

export const CHECK_FIELDS = "Check the highlighted fields.";

/** What a setting is called in messages. */
export const INTEGRATION_LABELS: Record<IntegrationName, string> = {
  slack: "Slack",
  email: "email",
  webhook: "the webhook",
};

const NO_KEY =
  "This process has no BETTER_AUTH_SECRET, so it cannot store or read secrets. Run it with the repository's compose.yaml, which passes BETTER_AUTH_SECRET to every service.";
const UNREADABLE = "The saved value cannot be read with the current BETTER_AUTH_SECRET: enter it again.";

let sealingKey: { secret: string; key: SealingKey } | undefined;

/** The key from this process's BETTER_AUTH_SECRET, or null without one. */
export function currentSealingKey(): SealingKey | null {
  const secret = parseSealingConfig().BETTER_AUTH_SECRET;
  if (!secret) return null;
  if (sealingKey?.secret !== secret) sealingKey = { secret, key: deriveSealingKey(secret) };
  return sealingKey.key;
}

/** Where the views look: this process's key, and the worker's report. */
export interface ViewContext {
  key: SealingKey | null;
  /** The worker has no BETTER_AUTH_SECRET, so it cannot read the secrets saved here. */
  workerWithoutKey: boolean;
}

/** With the latest worker heartbeat's report, or nothing while no worker has reported. */
export async function viewContext(db: Database): Promise<ViewContext> {
  const [row] = await db
    .select({ channels: workerHeartbeat.channels })
    .from(workerHeartbeat)
    .where(isNotNull(workerHeartbeat.beatAt))
    .orderBy(desc(workerHeartbeat.beatAt))
    .limit(1);
  return { key: currentSealingKey(), workerWithoutKey: row?.channels?.withoutKey === true };
}

/** The page's warnings for a setting: a worker without the key, secrets that cannot be read. */
function warningsFor(name: IntegrationName, context: ViewContext, unreadable: Unreadable[]): string[] {
  const warnings: string[] = [];
  if (context.workerWithoutKey) {
    warnings.push(
      'The worker has no BETTER_AUTH_SECRET, so it cannot read the secrets saved here. Pass it to the worker, as compose.yaml does (docs/deployment.md, "Operations").',
    );
  }
  for (const field of unreadable) {
    if (field.split(".")[0] === name) warnings.push(`${SECRET_LABELS[field]}: ${UNREADABLE}`);
  }
  return warnings;
}

const SECRET_LABELS: Record<Unreadable, string> = {
  "slack.botToken": "The bot token",
  "email.smtp.password": "The SMTP password",
  "email.mailersend.token": "The MailerSend API token",
  "webhook.url": "The URL",
  "webhook.secret": "The signing secret",
};

const saved = (value: Pick<Sealed, "hint"> | null) => ({ saved: value !== null, hint: value?.hint ?? null });

function slackState(slack: StoredSlack, unreadable: Unreadable[]): IntegrationState {
  if (slack.botToken && !unreadable.includes(SECRET_FIELDS.slackBotToken)) return "set";
  return slack.botToken || slack.channelId ? "incomplete" : "not set";
}

function emailState(email: StoredEmail, unreadable: Unreadable[]): IntegrationState {
  if (email.provider === "none") return "not set";
  const has = (value: Sealed | null, field: Unreadable) => value !== null && !unreadable.includes(field);
  const ready = emailReady({
    provider: email.provider,
    fromAddress: email.fromAddress,
    fromName: email.fromName,
    smtp: { ...email.smtp, password: has(email.smtp.password, SECRET_FIELDS.smtpPassword) ? "saved" : null },
    mailersendToken: has(email.mailersend.token, SECRET_FIELDS.mailerSendToken) ? "saved" : null,
  });
  return ready ? "set" : "incomplete";
}

function webhookState(webhook: StoredWebhook, unreadable: Unreadable[]): IntegrationState {
  if (!webhook.url) return "not set";
  return usable(webhook.url, SECRET_FIELDS.webhookUrl, unreadable) &&
    usable(webhook.secret, SECRET_FIELDS.webhookSecret, unreadable)
    ? "set"
    : "incomplete";
}

/** What the page shows, and what `cli settings show` prints. */
export function viewsOf(stored: StoredIntegrations, context: ViewContext): IntegrationViews {
  // Without a key nothing can be opened, which says nothing about the values.
  const unreadable = context.key ? openStored(stored, context.key).unreadable : [];
  const { slack, email, webhook } = stored;
  const botToken = saved(slack.botToken);
  const password = saved(email.smtp.password);
  const token = saved(email.mailersend.token);
  const url = saved(typeof webhook.url === "string" ? { hint: urlHint(webhook.url) } : webhook.url);
  const secret = saved(webhook.secret);
  const slackView: SlackView = {
    state: slackState(slack, unreadable),
    botTokenSaved: botToken.saved,
    botTokenHint: botToken.hint,
    channelId: slack.channelId,
    warnings: warningsFor("slack", context, unreadable),
  };
  const emailView: EmailView = {
    state: emailState(email, unreadable),
    provider: email.provider,
    fromAddress: email.fromAddress,
    fromName: email.fromName,
    smtp: {
      host: email.smtp.host,
      port: email.smtp.port,
      security: email.smtp.security,
      username: email.smtp.username,
      passwordSaved: password.saved,
      passwordHint: password.hint,
    },
    mailersend: { tokenSaved: token.saved, tokenHint: token.hint },
    warnings: warningsFor("email", context, unreadable),
  };
  const webhookView: WebhookView = {
    state: webhookState(webhook, unreadable),
    urlSaved: url.saved,
    urlHint: url.hint,
    secretSaved: secret.saved,
    secretHint: secret.hint,
    warnings: warningsFor("webhook", context, unreadable),
  };
  return { slack: slackView, email: emailView, webhook: webhookView };
}

export async function integrationViews(db: Database, context?: ViewContext): Promise<IntegrationViews> {
  const [{ stored }, resolved] = await Promise.all([loadStored(db), context ?? viewContext(db)]);
  return viewsOf(stored, resolved);
}

/**
 * A secret field after a save: undefined keeps the saved value, null removes
 * it, text is sealed. Sealing needs the key.
 */
function nextSecret<T>(
  current: T,
  input: string | null | undefined,
  field: Unreadable,
  key: SealingKey | null,
  path: string,
  hint: (value: string) => string | null = secretHint,
): T | Sealed | null {
  if (input === undefined) return current;
  if (input === null) return null;
  if (!key) throw new IntegrationError(NO_KEY, { [path]: "Not saved: this process cannot seal secrets." });
  return { sealed: seal(key, field, input), hint: hint(input) };
}

/** Whether a saved secret is usable for the checks: present, and readable when the key is at hand. */
function usable(value: Sealed | string | null, field: Unreadable, unreadable: Unreadable[]): boolean {
  return value !== null && !unreadable.includes(field);
}

function nextSlack(current: StoredSlack, body: unknown, key: SealingKey | null): StoredSlack {
  const input = INPUT_SCHEMAS.slack.parse(body);
  return {
    botToken: nextSecret(current.botToken, input.botToken, SECRET_FIELDS.slackBotToken, key, "botToken"),
    channelId: input.channelId,
  };
}

/** How well each setting protects the password in transit. */
const SECURITY_STRENGTH: Record<SmtpSecurity, number> = { tls: 2, starttls: 2, auto: 1, none: 0 };

function nextEmail(current: StoredEmail, body: unknown, key: SealingKey | null): StoredEmail {
  const input = INPUT_SCHEMAS.email.parse(body);
  // A body without `smtp`, such as {"provider": "none"}, keeps the saved SMTP settings.
  const smtpGiven = typeof body === "object" && body !== null && "smtp" in body;
  const next: StoredEmail = {
    provider: input.provider,
    fromAddress: input.fromAddress,
    fromName: input.fromName,
    smtp: smtpGiven
      ? {
          host: input.smtp.host,
          port: input.smtp.port,
          security: input.smtp.security,
          username: input.smtp.username,
          password: nextSecret(
            current.smtp.password,
            input.smtp.password,
            SECRET_FIELDS.smtpPassword,
            key,
            "smtp.password",
          ),
        }
      : current.smtp,
    mailersend: {
      token: nextSecret(
        current.mailersend.token,
        input.mailersend.token,
        SECRET_FIELDS.mailerSendToken,
        key,
        "mailersend.token",
      ),
    },
  };
  const unreadable = key ? openStored({ ...emptyBut("email", next) }, key).unreadable : [];
  const errors: IntegrationFieldErrors = {};
  if (next.fromAddress && !z.email().safeParse(next.fromAddress).success)
    errors.fromAddress = "Enter an email address.";
  // A kept password must not reach another server, or travel less protected,
  // also not by changing the server while another provider is chosen.
  const kept = smtpGiven && input.smtp.password === undefined && next.smtp.password !== null;
  if (kept && next.smtp.host !== current.smtp.host) {
    errors["smtp.password"] = "Enter the password again: the mail server changed.";
  } else if (kept && SECURITY_STRENGTH[next.smtp.security] < SECURITY_STRENGTH[current.smtp.security]) {
    errors["smtp.password"] = "Enter the password again: the encryption is weaker now.";
  }
  if (next.provider !== "none") {
    if (!next.fromAddress) errors.fromAddress = "Enter the sender address.";
    if (next.provider === "smtp") {
      const password = usable(next.smtp.password, SECRET_FIELDS.smtpPassword, unreadable);
      if (!next.smtp.host) errors["smtp.host"] = "Enter the mail server.";
      if (next.smtp.username && !password) {
        errors["smtp.password"] ??= next.smtp.password
          ? UNREADABLE
          : "Enter the password for this user name.";
      }
      if (!next.smtp.username && next.smtp.password)
        errors["smtp.username"] = "Enter the user name for this password.";
    } else if (!usable(next.mailersend.token, SECRET_FIELDS.mailerSendToken, unreadable)) {
      errors["mailersend.token"] = next.mailersend.token ? UNREADABLE : "Enter the API token.";
    }
  }
  if (Object.keys(errors).length > 0) throw new IntegrationError(CHECK_FIELDS, errors);
  return next;
}

function nextWebhook(current: StoredWebhook, body: unknown, key: SealingKey | null): StoredWebhook {
  const input = INPUT_SCHEMAS.webhook.parse(body);
  const next: StoredWebhook = {
    url: nextSecret(current.url, input.url, SECRET_FIELDS.webhookUrl, key, "url", urlHint),
    secret: nextSecret(current.secret, input.secret, SECRET_FIELDS.webhookSecret, key, "secret"),
  };
  const unreadable = key ? openStored(emptyBut("webhook", next), key).unreadable : [];
  const errors: IntegrationFieldErrors = {};
  if (next.url) {
    if (!usable(next.url, SECRET_FIELDS.webhookUrl, unreadable)) errors.url = UNREADABLE;
    if (!usable(next.secret, SECRET_FIELDS.webhookSecret, unreadable)) {
      errors.secret = next.secret ? UNREADABLE : "Enter a signing secret of at least 16 characters.";
    }
  }
  if (Object.keys(errors).length > 0) throw new IntegrationError(CHECK_FIELDS, errors);
  return next;
}

function emptyBut<N extends IntegrationName>(name: N, value: StoredIntegrations[N]): StoredIntegrations {
  const stored: StoredIntegrations = {
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
  return { ...stored, [name]: value };
}

/** The fields of a setting that a save changed, by path; secrets by name only. */
export function changedFields(before: unknown, after: unknown, prefix = ""): string[] {
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    !("sealed" in after) &&
    !("sealed" in before)
  ) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) =>
      changedFields(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        `${prefix}${key}.`,
      ),
    );
  }
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null) ? [] : [prefix.slice(0, -1)];
}

const NEXT = { slack: nextSlack, email: nextEmail, webhook: nextWebhook } as const;

/**
 * Saves a setting from the page's body, with the page's checks, and records
 * an audit event (who, and which fields changed; never a value). Throws
 * IntegrationError when the app refuses the body.
 */
export async function saveIntegration(
  db: Database,
  name: IntegrationName,
  body: unknown,
  actor: SettingsActor,
  key: SealingKey | null = currentSealingKey(),
): Promise<{ message: string; view: IntegrationViews[IntegrationName] }> {
  const parsed = INPUT_SCHEMAS[name].safeParse(body);
  if (!parsed.success) throw new IntegrationError(CHECK_FIELDS, fieldErrorsOf(parsed.error));
  const { actorId, payload } = auditActor(actor);
  await db.transaction(async (tx) => {
    await lockIntegrations(tx);
    const { stored } = await loadStored(tx);
    const before = stored[name];
    const next = (
      NEXT[name] as (current: typeof before, body: unknown, key: SealingKey | null) => typeof before
    )(before, body, key);
    await writeStored(tx, name, next, actorId);
    await recordAudit(tx, {
      actorId,
      action: `settings.${name}_changed`,
      payload: { ...payload, changed: changedFields(before, next) },
    });
  });
  const views = await integrationViews(db);
  return { message: `Saved ${INTEGRATION_LABELS[name]}.`, view: views[name] };
}

/** The settings as the worker would send with them now. */
async function transportsNow(db: Database, key: SealingKey | null) {
  const { stored } = await loadStored(db);
  const { integrations, unreadable } = openStored(stored, key);
  const mode = parseNotificationModeConfig().NOTIFICATION_TRANSPORT;
  // Links in test messages are not needed: the base URL can be missing here.
  const transports: Transports = createTransports({
    mode,
    baseUrl: "",
    slack: integrations.slack,
    email: integrations.email,
  });
  return { stored, integrations, unreadable, mode, transports };
}

const CONSOLE =
  "NOTIFICATION_TRANSPORT is console: Logbook only logs messages, so the test message went to the log.";

/**
 * The Slack test button: checks the saved token with Slack and, when a
 * channel is set, posts a test message there. Sends nothing else.
 */
export async function testSlack(
  db: Database,
  key: SealingKey | null = currentSealingKey(),
): Promise<TestResult> {
  const { stored, unreadable, mode, transports } = await transportsNow(db, key);
  if (!stored.slack.botToken) return { ok: false, message: "Save a bot token first." };
  if (unreadable.includes(SECRET_FIELDS.slackBotToken))
    return { ok: false, message: key ? `The bot token: ${UNREADABLE}` : NO_KEY };
  const slack = transports.slack!;
  const channel = stored.slack.channelId;
  try {
    const { team, user } = await slack.testAuth();
    if (channel)
      await slack.postMessage(
        channel,
        "This is a test message from Logbook (Admin › Integrations). New entries are posted to this channel.",
      );
    if (mode === "console") return { ok: true, message: CONSOLE };
    const who = `workspace ${team || "unknown"}, bot ${user || "unknown"}`;
    return {
      ok: true,
      message: channel
        ? `Slack accepted the token (${who}), and Logbook posted a test message to the channel.`
        : `Slack accepted the token (${who}). No channel is set, so nothing was posted.`,
    };
  } catch (error) {
    return { ok: false, message: `Slack refused: ${errorMessage(error)}` };
  }
}

/** The email test button: sends a test email to `to` with the saved settings. */
export async function testEmail(
  db: Database,
  input: unknown,
  key: SealingKey | null = currentSealingKey(),
): Promise<TestResult> {
  const parsed = emailTestSchema.safeParse(input);
  if (!parsed.success) throw new IntegrationError(CHECK_FIELDS, fieldErrorsOf(parsed.error));
  const { stored, unreadable, mode, transports } = await transportsNow(db, key);
  // Only the chosen provider's secret matters.
  const secret =
    stored.email.provider === "mailersend" ? SECRET_FIELDS.mailerSendToken : SECRET_FIELDS.smtpPassword;
  if (stored.email.provider !== "none" && unreadable.includes(secret))
    return { ok: false, message: key ? `${SECRET_LABELS[secret]}: ${UNREADABLE}` : NO_KEY };
  if (stored.email.provider === "none" || !transports.email) {
    return {
      ok: false,
      message: "Email is not set up: save a provider, its server or API token, and the sender first.",
    };
  }
  try {
    await transports.email.send({
      to: parsed.data.to,
      toName: parsed.data.to,
      subject: "Test email from Logbook",
      text: "This is a test email from Logbook (Admin › Integrations). Reminders and notifications will arrive like this one.",
      html: "<p>This is a test email from Logbook (Admin › Integrations). Reminders and notifications will arrive like this one.</p>",
    });
    return { ok: true, message: mode === "console" ? CONSOLE : `Sent a test email to ${parsed.data.to}.` };
  } catch (error) {
    const failed = "The test email could not be sent";
    if (transports.email.kind !== "smtp") return { ok: false, message: `${failed}: ${errorMessage(error)}` };
    // The mail server's own answer, or only a code: other errors can quote anything.
    const { reply, code } = error instanceof DeliveryError ? error : {};
    return {
      ok: false,
      message: reply
        ? `${failed}: the mail server answered "${reply}".`
        : `${failed}${code ? ` (${code})` : ""}.`,
    };
  }
}
