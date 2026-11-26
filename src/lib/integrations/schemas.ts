import { z } from "zod";

/*
 * The bodies of Admin › Integrations: what the page's forms send, and what
 * `cli settings apply <name>` reads from stdin. One schema for both, so the
 * command takes exactly the page's body. Free of server imports: the forms
 * use the constants and types.
 *
 * A secret field is write-only: omitted or "" keeps the saved value, null
 * removes it, any other text replaces it. Every other field is replaced by
 * what the body says, as the page's Save does. The fields that `show` adds
 * (`state`, the `…Saved` and `…Hint` fields, `warnings`) are accepted and
 * ignored, so a body can start from what `show` prints.
 */

export const INTEGRATION_NAMES = ["slack", "email", "webhook"] as const;
export type IntegrationName = (typeof INTEGRATION_NAMES)[number];

export const EMAIL_PROVIDERS = ["none", "smtp", "mailersend"] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

/**
 * `tls` on port 465, `starttls` (required) on 587, `auto` (STARTTLS when the
 * server offers it, as `smtp://` URLs of earlier versions did), `none` never.
 */
export const SMTP_SECURITY = ["starttls", "tls", "auto", "none"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY)[number];

export const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;
export const MIN_WEBHOOK_SECRET_LENGTH = 16;
export const DEFAULT_FROM_NAME = "Logbook";

/** Whether a setting can be used: everything it needs is saved. */
export type IntegrationState = "set" | "not set" | "incomplete";

/** Text that may be blank; trimmed. */
const text = (max: number, message: string) => z.string({ error: "Must be text." }).trim().max(max, message);

/** Text or null for "none"; blank counts as none. */
const optionalText = <T extends z.ZodType<string | null>>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    schema.nullable().default(null),
  );

/**
 * A write-only secret: undefined keeps the saved value, null removes it, a
 * string replaces it after `check`. "" counts as undefined, as the page's
 * secret field sends it.
 */
function secret(check: (value: string) => string | undefined) {
  return z
    .string({ error: "Must be text, or null to remove the saved value." })
    .max(2_000, "Too long.")
    .nullable()
    .optional()
    .transform((value) => (typeof value === "string" ? value.trim() || undefined : value))
    .superRefine((value, ctx) => {
      const problem = typeof value === "string" ? check(value) : undefined;
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    });
}

/** A field of `show`'s answer, accepted and ignored in a body. */
const shown = z.unknown().optional();

/**
 * Unknown fields are refused without being named: a field name could be a
 * secret typed into the wrong place.
 */
const strict = <T extends z.core.$ZodLooseShape>(shape: T, fields: string) =>
  z.strictObject(shape, {
    error: (issue) =>
      issue.code === "unrecognized_keys" ? `Unknown field (not shown). The fields are ${fields}.` : undefined,
  });

export const slackInputSchema = strict(
  {
    /** The bot token (xoxb-…) of a Slack app with chat:write, users:read, and users:read.email. */
    botToken: secret((value) =>
      value.startsWith("xoxb-") ? undefined : "Enter a bot token that starts with xoxb-.",
    ),
    /** The channel for one post per new entry; null for none. */
    channelId: optionalText(
      text(40, "Enter the channel's ID, such as C0123456789.").regex(
        SLACK_CHANNEL_ID,
        "Enter the channel's ID (C…), not its name.",
      ),
    ),
    state: shown,
    botTokenSaved: shown,
    botTokenHint: shown,
    warnings: shown,
  },
  "botToken and channelId",
);
export type SlackInput = z.input<typeof slackInputSchema>;

export const smtpInputSchema = strict(
  {
    host: text(255, "Use at most 255 characters.").default(""),
    port: z.coerce
      .number({ error: "Enter a port between 1 and 65535." })
      .int("Enter a port between 1 and 65535.")
      .min(1, "Enter a port between 1 and 65535.")
      .max(65_535, "Enter a port between 1 and 65535.")
      .default(587),
    security: z
      .enum(SMTP_SECURITY, { error: 'Choose "starttls", "tls", "auto", or "none".' })
      .default("starttls"),
    username: text(320, "Use at most 320 characters.").default(""),
    password: secret(() => undefined),
    passwordSaved: shown,
    passwordHint: shown,
  },
  "host, port, security, username, and password",
);

export const mailerSendInputSchema = strict(
  {
    token: secret(() => undefined),
    tokenSaved: shown,
    tokenHint: shown,
  },
  "token",
);

export const emailInputSchema = strict(
  {
    provider: z.enum(EMAIL_PROVIDERS, { error: 'Choose "none", "smtp", or "mailersend".' }),
    fromAddress: text(320, "Use at most 320 characters.").default(""),
    fromName: text(100, "Use at most 100 characters.").default(""),
    smtp: smtpInputSchema.default({
      host: "",
      port: 587,
      security: "starttls",
      username: "",
      password: undefined,
    }),
    mailersend: mailerSendInputSchema.default({ token: undefined }),
    state: shown,
    warnings: shown,
  },
  "provider, fromAddress, fromName, smtp, and mailersend",
);
export type EmailInput = z.input<typeof emailInputSchema>;

const httpUrl = z.url({ protocol: /^https?$/ });

export const webhookInputSchema = strict(
  {
    /** Where entries are posted, a secret too: it can carry a token. null turns the webhook off. */
    url: secret((value) =>
      httpUrl.safeParse(value).success ? undefined : "Enter an http:// or https:// URL.",
    ),
    /** Signs every request (Logbook-Signature). */
    secret: secret((value) =>
      value.length >= MIN_WEBHOOK_SECRET_LENGTH
        ? undefined
        : `Use at least ${MIN_WEBHOOK_SECRET_LENGTH} characters.`,
    ),
    state: shown,
    urlSaved: shown,
    urlHint: shown,
    secretSaved: shown,
    secretHint: shown,
    warnings: shown,
  },
  "url and secret",
);
export type WebhookInput = z.input<typeof webhookInputSchema>;

export const INPUT_SCHEMAS = {
  slack: slackInputSchema,
  email: emailInputSchema,
  webhook: webhookInputSchema,
} as const;

export const emailTestSchema = z.object({
  to: z
    .string({ error: "Enter an email address." })
    .trim()
    .pipe(z.email({ error: "Enter an email address." })),
});

/** What the page and `cli settings show` show. Secrets only as hints. */
export interface SlackView {
  state: IntegrationState;
  botTokenSaved: boolean;
  botTokenHint: string | null;
  channelId: string | null;
  warnings: string[];
}

export interface EmailView {
  state: IntegrationState;
  provider: EmailProvider;
  fromAddress: string;
  fromName: string;
  smtp: {
    host: string;
    port: number;
    security: SmtpSecurity;
    username: string;
    passwordSaved: boolean;
    passwordHint: string | null;
  };
  mailersend: { tokenSaved: boolean; tokenHint: string | null };
  warnings: string[];
}

export interface WebhookView {
  state: IntegrationState;
  urlSaved: boolean;
  /** The URL's server. */
  urlHint: string | null;
  secretSaved: boolean;
  secretHint: string | null;
  warnings: string[];
}

export interface IntegrationViews {
  slack: SlackView;
  email: EmailView;
  webhook: WebhookView;
}

/** The result of a test button. */
export interface TestResult {
  ok: boolean;
  message: string;
}

/** Field errors by path, such as "smtp.host". */
export type IntegrationFieldErrors = Record<string, string>;

/** Field errors of a zod error, by dotted path. */
export function fieldErrorsOf(error: z.ZodError): IntegrationFieldErrors {
  const errors: IntegrationFieldErrors = {};
  for (const issue of error.issues) {
    const path = issue.path.map(String).join(".") || "body";
    errors[path] ??= issue.message;
  }
  return errors;
}
