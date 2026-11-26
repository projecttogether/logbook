import nodemailer from "nodemailer";
import { DEFAULT_FROM_NAME, type SmtpSecurity } from "@/lib/integrations/schemas";
import type { EmailSettings, SlackSettings, Unreadable } from "@/lib/integrations/store";
import { logger } from "@/lib/logger";
import { smtpReply } from "./smtp-reply";
import type { ChannelMode, NotificationChannels } from "./types";

/*
 * Slack over its Web API, email over SMTP or the MailerSend API, plus console
 * transports for development and tests, which only log.
 */

/**
 * A failed send. A permanent error (a bad token, a missing scope, a rejected
 * address) stays until someone changes something, so the worker tries the
 * other channel at once. Other errors are retried with backoff, at most 5
 * attempts, and the last attempt tries the other channel too.
 */
export class DeliveryError extends Error {
  readonly code?: string;
  /** What the mail server answered, for the test button (`smtpReply`). */
  readonly reply?: string;
  readonly retryAfterMs?: number;
  readonly permanent: boolean;
  constructor(
    message: string,
    options: { code?: string; reply?: string; retryAfterMs?: number; permanent?: boolean } = {},
  ) {
    super(message);
    this.name = "DeliveryError";
    this.code = options.code;
    this.reply = options.reply;
    this.retryAfterMs = options.retryAfterMs;
    this.permanent = options.permanent ?? false;
  }
}

/** HTTP statuses that may pass: timeouts, rate limits, and server errors. Other 4xx answers are permanent. */
const temporaryStatus = (status: number) => status === 408 || status === 429 || status >= 500;

/** "unreadable": the channel is set up, but its saved secret cannot be read, so every send fails. */
export type TransportMode = "live" | "console" | "unreadable";

export interface SlackTransport {
  mode: TransportMode;
  /** The workspace and the bot's name, for the test button: checks the token. */
  testAuth(): Promise<{ team: string; user: string }>;
  /** The Slack user ID for a work email, or null if there is no such (active) user. */
  lookupUserByEmail(email: string): Promise<string | null>;
  /** Sends a direct message from the app to a Slack user. */
  postMessage(userId: string, text: string): Promise<void>;
}

export interface Email {
  to: string;
  toName: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailTransport {
  mode: TransportMode;
  /** "smtp", "mailersend", "console", or "unreadable". */
  kind: string;
  send(email: Email): Promise<void>;
}

export interface Transports {
  slack?: SlackTransport;
  /** The Slack channel for one post per entry (Admin › Integrations). */
  slackChannelId?: string;
  email?: EmailTransport;
  /** LOGBOOK_BASE_URL, for links in messages. */
  baseUrl: string;
}

/** What the admin page shows for each channel. */
export function channelModes(transports: Transports): NotificationChannels {
  const mode = (t: { mode: TransportMode } | undefined): ChannelMode =>
    !t || t.mode === "unreadable" ? "off" : t.mode;
  return {
    slack: mode(transports.slack),
    slackChannel: transports.slackChannelId ? mode(transports.slack) : "off",
    email: mode(transports.email),
  };
}

const TIMEOUT_MS = 15_000;

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  user?: { id: string; deleted?: boolean } | string;
  team?: string;
}

/** Slack errors that may pass. Every other one (a bad token, a missing scope, an unknown user) is permanent. */
const SLACK_TEMPORARY = new Set([
  "ratelimited",
  "rate_limited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
]);

function slackError(method: string, error: string | undefined): DeliveryError {
  return new DeliveryError(`Slack ${method}: ${error ?? "unknown error"}`, {
    code: error,
    permanent: error !== undefined && !SLACK_TEMPORARY.has(error),
  });
}

export function createSlackTransport(token: string, fetchImpl: typeof fetch = fetch): SlackTransport {
  async function call(
    method: string,
    init: { query?: Record<string, string>; body?: Record<string, unknown> },
  ): Promise<SlackResponse> {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [name, value] of Object.entries(init.query ?? {})) url.searchParams.set(name, value);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: init.body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new DeliveryError(`Slack ${method}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 429)
      throw new DeliveryError(`Slack ${method}: rate limited`, {
        code: "ratelimited",
        retryAfterMs: retryAfterMs(response),
      });
    if (!response.ok)
      throw new DeliveryError(`Slack ${method}: HTTP ${response.status}`, {
        permanent: !temporaryStatus(response.status),
      });
    return (await response.json()) as SlackResponse;
  }

  return {
    mode: "live",
    async testAuth() {
      const result = await call("auth.test", { body: {} });
      if (!result.ok) throw slackError("auth.test", result.error);
      return { team: result.team ?? "", user: typeof result.user === "string" ? result.user : "" };
    },
    async lookupUserByEmail(email) {
      const result = await call("users.lookupByEmail", { query: { email } });
      if (!result.ok) {
        if (result.error === "users_not_found") return null;
        throw slackError("users.lookupByEmail", result.error);
      }
      const user = typeof result.user === "object" ? result.user : undefined;
      return user && !user.deleted ? user.id : null;
    },
    async postMessage(userId, text) {
      const result = await call("chat.postMessage", {
        body: { channel: userId, text, unfurl_links: false, unfurl_media: false },
      });
      if (!result.ok) throw slackError("chat.postMessage", result.error);
    },
  };
}

export function createMailerSendTransport(
  options: { token: string; from: string; fromName: string },
  fetchImpl: typeof fetch = fetch,
): EmailTransport {
  return {
    mode: "live",
    kind: "mailersend",
    async send(email) {
      let response: Response;
      try {
        response = await fetchImpl("https://api.mailersend.com/v1/email", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.token}`,
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: JSON.stringify({
            from: { email: options.from, name: options.fromName },
            to: [{ email: email.to, name: email.toName }],
            subject: email.subject,
            text: email.text,
            html: email.html,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new DeliveryError(`MailerSend: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Provider response bodies can echo email content. Diagnostics use only the status.
      void response.body?.cancel().catch(() => {});
      if (response.ok) return;
      throw new DeliveryError(`MailerSend: HTTP ${response.status}`, {
        retryAfterMs: retryAfterMs(response),
        permanent: !temporaryStatus(response.status),
      });
    },
  };
}

/**
 * Mail servers answer 4xx for temporary and 5xx for permanent errors. Failed
 * authentication is permanent too; connection errors are temporary.
 */
interface SmtpError extends Error {
  responseCode?: number;
  code?: string;
}

export function createSmtpTransport(
  options: {
    host: string;
    port: number;
    security: SmtpSecurity;
    username: string;
    password: string | null;
    from: string;
    fromName: string;
  },
  createTransport: typeof nodemailer.createTransport = nodemailer.createTransport,
): EmailTransport {
  const transporter = createTransport({
    host: options.host,
    port: options.port,
    // `tls`: TLS from the start (465); `starttls`: upgrade, or fail (587);
    // `auto`: upgrade when the server offers it; `none`: never.
    secure: options.security === "tls",
    requireTLS: options.security === "starttls",
    ignoreTLS: options.security === "none",
    auth: options.username ? { user: options.username, pass: options.password ?? "" } : undefined,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
  return {
    mode: "live",
    kind: "smtp",
    async send(email) {
      try {
        await transporter.sendMail({
          from: { name: options.fromName, address: options.from },
          to: { name: email.toName, address: email.to },
          subject: email.subject,
          text: email.text,
          html: email.html,
        });
      } catch (error) {
        const smtp = error as SmtpError;
        const detail = smtp.responseCode ? `SMTP ${smtp.responseCode}` : (smtp.code ?? "SMTP");
        throw new DeliveryError(`${detail}: ${smtp.message}`.slice(0, 500), {
          code: smtp.code,
          reply: smtpReply(smtp, options) ?? undefined,
          permanent: (smtp.responseCode ?? 0) >= 500 || smtp.code === "EAUTH",
        });
      }
    },
  };
}

/** Logs Slack messages instead of sending them (development and tests). */
export function createConsoleSlackTransport(): SlackTransport {
  return {
    mode: "console",
    testAuth: async () => ({ team: "console", user: "console" }),
    lookupUserByEmail: async () => null,
    async postMessage(userId, text) {
      logger.info({ channel: "slack", to: userId, text }, "notification (console transport)");
    },
  };
}

/** Logs emails instead of sending them (development and tests). */
export function createConsoleEmailTransport(): EmailTransport {
  return {
    mode: "console",
    kind: "console",
    async send(email) {
      logger.info(
        { channel: "email", to: email.to, subject: email.subject, text: email.text },
        "notification (console transport)",
      );
    },
  };
}

/*
 * A channel that is set up, but whose saved secret cannot be read (a changed
 * BETTER_AUTH_SECRET, or a worker without it). It is not off: a message goes
 * out on the other channel or is tried again, and ends as failed, not skipped.
 */
const secretUnreadable = (secret: string) =>
  new DeliveryError(`${secret} cannot be read by the worker: see Admin › Integrations.`, { permanent: true });

function createUnreadableSlackTransport(): SlackTransport {
  const fail = async (): Promise<never> => {
    throw secretUnreadable("The Slack bot token");
  };
  return { mode: "unreadable", testAuth: fail, lookupUserByEmail: fail, postMessage: fail };
}

function createUnreadableEmailTransport(secret: string): EmailTransport {
  return {
    mode: "unreadable",
    kind: "unreadable",
    async send() {
      throw secretUnreadable(secret);
    },
  };
}

/** Whether email can be sent with these settings: a provider, its server or token, and a sender. */
export function emailReady(email: EmailSettings): boolean {
  if (email.provider === "none" || !email.fromAddress) return false;
  if (email.provider === "mailersend") return Boolean(email.mailersendToken);
  return Boolean(email.smtp.host) && (!email.smtp.username || Boolean(email.smtp.password));
}

function createEmailTransport(
  email: EmailSettings,
  unreadable: readonly Unreadable[],
): EmailTransport | undefined {
  if (email.fromAddress && email.provider === "mailersend" && unreadable.includes("email.mailersend.token")) {
    return createUnreadableEmailTransport("The MailerSend API token");
  }
  if (
    email.fromAddress &&
    email.provider === "smtp" &&
    email.smtp.host &&
    email.smtp.username &&
    unreadable.includes("email.smtp.password")
  ) {
    return createUnreadableEmailTransport("The SMTP password");
  }
  if (!emailReady(email)) return undefined;
  const from = { from: email.fromAddress, fromName: email.fromName || DEFAULT_FROM_NAME };
  if (email.provider === "mailersend")
    return createMailerSendTransport({ token: email.mailersendToken!, ...from });
  return createSmtpTransport({ ...email.smtp, ...from });
}

/**
 * The transports for the settings of Admin › Integrations. A channel without
 * its settings is off; one whose secret is in `unreadable` fails each send.
 * `console` (NOTIFICATION_TRANSPORT, development and tests) logs every
 * message instead.
 */
export function createTransports(options: {
  mode: "live" | "console";
  baseUrl: string;
  slack: SlackSettings;
  email: EmailSettings;
  /** Saved secrets that could not be opened (`openStored`). */
  unreadable?: readonly Unreadable[];
}): Transports {
  const unreadable = options.unreadable ?? [];
  if (options.mode === "console") {
    return {
      baseUrl: options.baseUrl,
      slack: createConsoleSlackTransport(),
      slackChannelId: options.slack.channelId ?? "console-channel",
      email: createConsoleEmailTransport(),
    };
  }
  return {
    baseUrl: options.baseUrl,
    slack: options.slack.botToken
      ? createSlackTransport(options.slack.botToken)
      : unreadable.includes("slack.botToken")
        ? createUnreadableSlackTransport()
        : undefined,
    slackChannelId: options.slack.channelId ?? undefined,
    email: createEmailTransport(options.email, unreadable),
  };
}
