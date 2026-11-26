import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { operator } from "@/lib/audit/actor";
import type { Database } from "@/lib/db/client";
import {
  INTEGRATION_NAMES,
  type IntegrationName,
  type IntegrationViews,
  type TestResult,
} from "@/lib/integrations/schemas";
import { integrationViews, saveIntegration, testEmail, testSlack } from "@/lib/integrations/service";
import { UsageError, type CliIo } from "./io";

/*
 * `cli settings …`: what admins set under Admin › Integrations, with the
 * functions the page's Server Actions call, as the operator (an admin's
 * rights; the audit log names the operator and the command).
 */

/** One line per setting in `cli help`. */
export const SETTING_LABELS: Record<IntegrationName, string> = {
  slack: "Slack: the bot token, and the channel for new entries",
  email: "Email: SMTP or MailerSend, and the sender",
  webhook: "Webhook: the URL that receives published entries, and its signing secret",
};

const USAGE = "cli settings list|show|apply|test <name>";
const TEST_EMAIL_USAGE = "cli settings test email --to <address>";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The options of a command. Messages never repeat what was typed: it could be a secret. */
function parse(
  args: string[],
  options: ParseArgsOptionsConfig,
  usage: string,
): Record<string, string | boolean | undefined> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, options, strict: true, allowPositionals: true });
  } catch (error) {
    const known = (error as { code?: unknown }).code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE";
    throw new UsageError(known ? `${(error as Error).message}.` : "Unknown option.", usage);
  }
  if (parsed.positionals.length > 0)
    throw new UsageError("Too many arguments. A body goes on stdin, never in an argument.", usage);
  if (parsed.values.id !== undefined)
    throw new UsageError("Logbook's settings are single settings, not lists: leave out --id.", usage);
  return parsed.values as Record<string, string | boolean | undefined>;
}

const ID = { id: { type: "string" } } as const;

/** What `list` shows of a setting: its state and hints, never a secret. */
function status(name: IntegrationName, views: IntegrationViews): { state: string; hints: string[] } {
  const hints: string[] = [];
  if (name === "slack") {
    const slack = views.slack;
    if (slack.botTokenSaved) hints.push(`token ${slack.botTokenHint ?? "saved"}`);
    if (slack.channelId) hints.push(`channel ${slack.channelId}`);
    return { state: slack.state, hints };
  }
  if (name === "email") {
    const email = views.email;
    if (email.provider !== "none") hints.push(email.provider);
    if (email.fromAddress) hints.push(`from ${email.fromAddress}`);
    if (email.provider === "smtp") {
      if (email.smtp.host)
        hints.push(`server ${email.smtp.host}:${email.smtp.port} (${email.smtp.security})`);
      if (email.smtp.passwordSaved) hints.push(`password ${email.smtp.passwordHint ?? "saved"}`);
    } else if (email.provider === "mailersend" && email.mailersend.tokenSaved) {
      hints.push(`token ${email.mailersend.tokenHint ?? "saved"}`);
    }
    return { state: email.state, hints };
  }
  const webhook = views.webhook;
  if (webhook.urlSaved) hints.push(`url ${webhook.urlHint ?? "saved"}`);
  if (webhook.secretSaved) hints.push(`secret ${webhook.secretHint ?? "saved"}`);
  return { state: webhook.state, hints };
}

function settingName(value: string | undefined, usage: string): IntegrationName {
  const names = INTEGRATION_NAMES.join(", ");
  if (!value || value.startsWith("-")) throw new UsageError(`Name the setting: ${names}.`, usage);
  if (!(INTEGRATION_NAMES as readonly string[]).includes(value))
    throw new UsageError(`Unknown setting. The settings are ${names}.`, usage);
  return value as IntegrationName;
}

function isJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** `cli settings …`. Returns the exit code; throws UsageError or IntegrationError. */
export async function settingsCommand(args: string[], io: CliIo, database: () => Database): Promise<number> {
  const [command, ...rest] = args;

  if (command === "list") {
    const values = parse(rest, { json: { type: "boolean" } }, "cli settings list [--json]");
    const views = await integrationViews(database());
    const rows = INTEGRATION_NAMES.map((name) => ({
      name,
      ...status(name, views),
      warnings: views[name].warnings,
    }));
    if (values.json) {
      io.out(json(rows));
      return 0;
    }
    const width = Math.max(...rows.map((row) => row.name.length));
    for (const row of rows)
      io.out(`${`${row.name.padEnd(width)}  ${row.state.padEnd(10)}  ${row.hints.join(", ")}`.trimEnd()}\n`);
    // A worker without the key, secrets that cannot be read.
    for (const warning of new Set(rows.flatMap((row) => row.warnings))) io.err(`${warning}\n`);
    return 0;
  }

  if (command !== "show" && command !== "apply" && command !== "remove" && command !== "test") {
    throw new UsageError(command === undefined ? "Name a command." : "Unknown command.", USAGE);
  }
  const [rawName, ...options] = rest;
  const usage = `cli settings ${command} <name>`;
  const name = settingName(rawName, usage);

  switch (command) {
    case "show":
      parse(options, ID, usage);
      io.out(json((await integrationViews(database()))[name]));
      return 0;
    case "apply": {
      parse(options, ID, `${usage} < body.json`);
      // The whole body first: nothing is read or locked before it is in.
      const body = isJson(await io.readStdin());
      if (!body.ok) throw new UsageError("The body on stdin is not JSON.", `${usage} < body.json`);
      const { message, view } = await saveIntegration(
        database(),
        name,
        body.value,
        operator(`cli settings apply ${name}`),
      );
      io.err(`${message}\n`);
      io.out(json(view));
      return 0;
    }
    case "remove":
      throw new UsageError(
        `${name} is a single setting, not a list: apply a body to change it (null removes a saved secret).`,
      );
    case "test": {
      let result: TestResult;
      if (name === "slack") {
        parse(options, ID, "cli settings test slack");
        result = await testSlack(database());
      } else if (name === "email") {
        const values = parse(options, { ...ID, to: { type: "string" } }, TEST_EMAIL_USAGE);
        if (typeof values.to !== "string")
          throw new UsageError("Name the address for the test email.", TEST_EMAIL_USAGE);
        result = await testEmail(database(), { to: values.to });
      } else {
        throw new UsageError("webhook has no test: the page has none either.");
      }
      io.out(json(result));
      if (result.ok) return 0;
      io.err(`${result.message}\n`);
      return 1;
    }
  }
}
