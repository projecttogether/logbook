import { z } from "zod";

/**
 * Environment configuration, validated with zod.
 *
 * Each process validates only what it needs: `migrate` needs the database,
 * the worker also needs the directory and the notification mode, and the web
 * process needs the database, login, and the directory. Empty strings count
 * as unset, because some platforms pass unset variables as "".
 *
 * Slack, email, and the webhook are not configured here: admins set them
 * under Admin › Integrations or with `cli settings` (src/lib/integrations).
 */

type Env = Record<string, string | undefined>;

const blankAsUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/** A variable that must be set; when it is not, the error says so instead of naming types. */
const required = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    blankAsUndefined,
    z
      .any()
      .refine((value) => value !== undefined, { message: "is required", abort: true })
      .pipe(schema),
  );
const requiredString = () => required(z.string().min(1));
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankAsUndefined, schema.optional());

const httpUrl = z.url({ protocol: /^https?$/ });
const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, "");

/** The value of BETTER_AUTH_SECRET in `.env.example`, refused in production. */
const EXAMPLE_SECRET = "development-secret-development-secret";

/** A Keycloak group path such as "/logbook" or "/staff/logbook". */
const groupPath = z.string().regex(/^\/[^/].*[^/]$|^\/[^/]$/, 'must be a group path such as "/logbook"');

/** A list of email addresses, separated by commas, semicolons, or spaces. Lower-cased. */
const emailList = z.preprocess(
  (value) =>
    typeof value === "string"
      ? value
          .split(/[\s,;]+/)
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean)
      : [],
  z.array(z.email()),
);

/** "true" or "false"; unset means `fallback`. */
const flag = (fallback: boolean) =>
  z
    .preprocess(
      blankAsUndefined,
      z.enum(["true", "false"], { error: 'must be "true" or "false"' }).optional(),
    )
    .transform((value) => (value === undefined ? fallback : value === "true"));

/**
 * Fills in defaults for unset or blank variables. The Keycloak directory uses
 * the login client unless it has its own.
 */
function withDefaults(env: Env): Env {
  const value = (name: string) => blankAsUndefined(env[name]) as string | undefined;
  return {
    ...env,
    LOGBOOK_BASE_URL: value("LOGBOOK_BASE_URL") ?? value("LOGBUCH_BASE_URL"),
    DIRECTORY: value("DIRECTORY") ?? "manual",
    OIDC_SCOPES: value("OIDC_SCOPES") ?? "openid profile email",
    KEYCLOAK_CLIENT_ID: value("KEYCLOAK_CLIENT_ID") ?? value("OIDC_CLIENT_ID"),
    KEYCLOAK_CLIENT_SECRET: value("KEYCLOAK_CLIENT_SECRET") ?? value("OIDC_CLIENT_SECRET"),
    // Production sends for real; development and tests only log.
    NOTIFICATION_TRANSPORT:
      value("NOTIFICATION_TRANSPORT") ?? (env.NODE_ENV === "production" ? "live" : "console"),
  };
}

const databaseSchema = z.object({
  DATABASE_URL: required(z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL")),
});

const authSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    LOGBOOK_BASE_URL: required(httpUrl.transform(withoutTrailingSlash)),
    BETTER_AUTH_SECRET: required(z.string().min(32, "must be at least 32 characters")),
    OIDC_ISSUER: required(httpUrl.transform(withoutTrailingSlash)),
    OIDC_CLIENT_ID: requiredString(),
    OIDC_CLIENT_SECRET: requiredString(),
    OIDC_SCOPES: requiredString(),
    /**
     * Treat every email address from the provider as verified. Only for
     * providers that do not send `email_verified` (e.g. Microsoft Entra ID)
     * and whose users cannot choose their own address.
     */
    OIDC_TRUST_EMAIL: flag(false),
  })
  .refine((env) => env.NODE_ENV !== "production" || env.BETTER_AUTH_SECRET !== EXAMPLE_SECRET, {
    message: "is the example value from .env.example; generate one with `openssl rand -base64 32`",
    path: ["BETTER_AUTH_SECRET"],
  })
  .transform(({ NODE_ENV: _, ...config }) => config);

/**
 * Where people, teams, and access come from:
 *
 * - `manual`: admins invite people and manage teams in Logbook. While there
 *   is no admin, the first login with an address in INITIAL_ADMIN_EMAILS
 *   becomes one; without that list nobody could ever get in.
 * - `keycloak`: a sync reads the members of Keycloak groups through the
 *   Keycloak Admin API. Every entry belongs to a team, and teams, tags, and
 *   stuck proposals need admins, so all three groups are required.
 */
const directorySchema = z.discriminatedUnion("DIRECTORY", [
  z.object({
    DIRECTORY: z.literal("manual"),
    INITIAL_ADMIN_EMAILS: emailList.refine((emails) => emails.length > 0, {
      message: "is required with DIRECTORY=manual: list the email addresses of the first admins",
    }),
  }),
  z.object({
    DIRECTORY: z.literal("keycloak"),
    OIDC_ISSUER: required(
      httpUrl
        .transform(withoutTrailingSlash)
        .refine(
          (url) => /\/realms\/[^/]+$/.test(url),
          "must be a Keycloak realm URL ending in /realms/<realm>",
        ),
    ),
    KEYCLOAK_CLIENT_ID: requiredString(),
    KEYCLOAK_CLIENT_SECRET: requiredString(),
    KEYCLOAK_ACCESS_GROUP: required(groupPath),
    KEYCLOAK_ADMIN_GROUP: required(groupPath),
    KEYCLOAK_TEAMS_GROUP: required(groupPath),
  }),
]);

/**
 * Notifications. Slack and email are set under Admin › Integrations; this
 * only says whether the worker sends for real or only logs (development and
 * tests), and where links in messages point.
 */
const notificationModeSchema = z.object({
  NOTIFICATION_TRANSPORT: z.enum(["live", "console"], { error: 'must be "live" or "console"' }),
});
const notificationSchema = notificationModeSchema.extend({
  LOGBOOK_BASE_URL: required(httpUrl.transform(withoutTrailingSlash)),
});

/**
 * The key that seals the secrets of the integrations (src/lib/integrations/crypto.ts).
 * The web process requires BETTER_AUTH_SECRET (authSchema); the worker, the
 * `migrate` service and the operator command start without it, but then
 * cannot read or store those secrets.
 */
const sealingSchema = z.object({
  BETTER_AUTH_SECRET: optional(z.string().min(32, "must be at least 32 characters")),
});

/** The version: the first 12 characters of the commit the image was built from. Images built from source have none. */
const versionSchema = z.object({
  APP_VERSION: optional(z.string()),
});

/** Error reporting to Sentry: off until SENTRY_DSN is set. Without SENTRY_RELEASE, the release is named after APP_VERSION. */
const errorReportingSchema = z.object({
  ...versionSchema.shape,
  SENTRY_DSN: optional(httpUrl),
  SENTRY_ENVIRONMENT: optional(z.string()),
  SENTRY_RELEASE: optional(z.string()),
});

export type DatabaseConfig = z.infer<typeof databaseSchema>;
export type AuthConfig = z.infer<typeof authSchema>;
export type DirectoryConfig = z.infer<typeof directorySchema>;
export type KeycloakDirectoryConfig = Extract<DirectoryConfig, { DIRECTORY: "keycloak" }>;
export type NotificationConfig = z.infer<typeof notificationSchema>;
export type NotificationModeConfig = z.infer<typeof notificationModeSchema>;
export type SealingConfig = z.infer<typeof sealingSchema>;
export type VersionConfig = z.infer<typeof versionSchema>;
export type ErrorReportingConfig = z.infer<typeof errorReportingSchema>;

export class ConfigError extends Error {
  constructor(issues: z.core.$ZodIssue[]) {
    const lines = issues.map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    super(`Invalid environment configuration:\n${lines.join("\n")}`);
    this.name = "ConfigError";
  }
}

function parse<T extends z.ZodType>(schema: T, env: Env): z.infer<T> {
  const result = schema.safeParse(withDefaults(env));
  if (!result.success) throw new ConfigError(result.error.issues);
  return result.data;
}

export function parseDatabaseConfig(env: Env = process.env): DatabaseConfig {
  return parse(databaseSchema, env);
}

export function parseAuthConfig(env: Env = process.env): AuthConfig {
  return parse(authSchema, env);
}

export function parseDirectoryConfig(env: Env = process.env): DirectoryConfig {
  return parse(directorySchema, env);
}

export function parseNotificationConfig(env: Env = process.env): NotificationConfig {
  return parse(notificationSchema, env);
}

/** Only whether messages are sent or logged: the test buttons and `cli settings test` need no base URL. */
export function parseNotificationModeConfig(env: Env = process.env): NotificationModeConfig {
  return parse(notificationModeSchema, env);
}

export function parseSealingConfig(env: Env = process.env): SealingConfig {
  return parse(sealingSchema, env);
}

export function parseVersionConfig(env: Env = process.env): VersionConfig {
  return parse(versionSchema, env);
}

export function parseErrorReportingConfig(env: Env = process.env): ErrorReportingConfig {
  return parse(errorReportingSchema, env);
}

function validate(schemas: readonly z.ZodType[], env: Env): void {
  const issues: z.core.$ZodIssue[] = [];
  const withDefaultValues = withDefaults(env);
  for (const schema of schemas) {
    const result = schema.safeParse(withDefaultValues);
    if (!result.success) issues.push(...result.error.issues);
  }
  if (issues.length > 0) throw new ConfigError(issues);
}

/** Validates every variable the web process needs. Called once at startup. */
export function validateWebConfig(env: Env = process.env): void {
  validate([databaseSchema, authSchema, directorySchema, errorReportingSchema], env);
}

/** Validates every variable the worker needs. */
export function validateWorkerConfig(env: Env = process.env): void {
  validate([databaseSchema, directorySchema, notificationSchema, sealingSchema, errorReportingSchema], env);
}

let databaseConfig: DatabaseConfig | undefined;
let authConfig: AuthConfig | undefined;
let directoryConfig: DirectoryConfig | undefined;
let notificationConfig: NotificationConfig | undefined;
let sealingConfig: SealingConfig | undefined;
let versionConfig: VersionConfig | undefined;
let errorReportingConfig: ErrorReportingConfig | undefined;

export function getDatabaseConfig(): DatabaseConfig {
  databaseConfig ??= parseDatabaseConfig();
  return databaseConfig;
}

export function getAuthConfig(): AuthConfig {
  authConfig ??= parseAuthConfig();
  return authConfig;
}

export function getDirectoryConfig(): DirectoryConfig {
  directoryConfig ??= parseDirectoryConfig();
  return directoryConfig;
}

export function getNotificationConfig(): NotificationConfig {
  notificationConfig ??= parseNotificationConfig();
  return notificationConfig;
}

export function getSealingConfig(): SealingConfig {
  sealingConfig ??= parseSealingConfig();
  return sealingConfig;
}

export function getVersionConfig(): VersionConfig {
  versionConfig ??= parseVersionConfig();
  return versionConfig;
}

export function getErrorReportingConfig(): ErrorReportingConfig {
  errorReportingConfig ??= parseErrorReportingConfig();
  return errorReportingConfig;
}
