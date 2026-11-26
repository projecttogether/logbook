import { DrizzleQueryError } from "drizzle-orm";
import { DatabaseError } from "pg";
import { ConfigError } from "@/lib/config";
import type { Database } from "@/lib/db/client";
import { INTEGRATION_NAMES } from "@/lib/integrations/schemas";
import { IntegrationError } from "@/lib/integrations/service";
import { logger } from "@/lib/logger";
import { UsageError, type CliIo } from "./io";
import { SETTING_LABELS, settingsCommand } from "./settings";

const DOCS =
  "https://github.com/projecttogether/logbook/blob/main/docs/deployment.md#settings-from-the-command-line";

function help(): string {
  const width = Math.max(...INTEGRATION_NAMES.map((name) => name.length));
  return `Logbook: the operator command. On a server with compose.yaml:
  docker compose run --rm -T migrate cli <command>
In a terminal of the app's container: cli <command>

Commands:
  cli settings list [--json]              every setting: set, not set, or incomplete, with hints
  cli settings show <name>                the setting as JSON, as Admin › Integrations shows it
  cli settings apply <name> < body.json   save the page's JSON body from stdin, with the page's checks
  cli settings test slack                 check the bot token and post to the channel
  cli settings test email --to <address>  send a test email
  cli help                                this text

Settings (Admin › Integrations):
${INTEGRATION_NAMES.map((name) => `  ${name.padEnd(width)}  ${SETTING_LABELS[name]}`).join("\n")}

Logbook issues no tokens, so there is no "cli tokens".
Secrets go only on stdin, never in an argument; output shows hints only.
Exit codes: 0 done, 1 refused (the page's message on stderr), 2 wrong command
or a body that is not JSON. Example bodies: ${DOCS}
`;
}

const isDatabaseError = (error: unknown) =>
  error instanceof DrizzleQueryError || error instanceof DatabaseError;

/**
 * What went wrong, for stderr. A database error gets the page's generic
 * message: its text can quote values, and a failed query carries them.
 */
function report(error: unknown, io: CliIo): number {
  if (error instanceof UsageError) {
    io.err(
      `${error.message}\n${error.usage ? `Usage: ${error.usage}\n` : ""}Run "cli help" for the commands.\n`,
    );
    return 2;
  }
  if (error instanceof IntegrationError) {
    io.err(`${error.message}\n`);
    for (const [field, message] of Object.entries(error.fieldErrors)) io.err(`  ${field}: ${message}\n`);
    return 1;
  }
  if (error instanceof ConfigError) {
    // Names and rules of variables, never their values.
    io.err(`${error.message}\n`);
    return 1;
  }
  const cause = isDatabaseError(error)
    ? error instanceof DrizzleQueryError
      ? error.cause
      : error
    : undefined;
  const code = (cause as { code?: unknown } | undefined)?.code;
  // The logger keeps the values of a failed query out of the log.
  logger.error({ err: error }, "operator command failed");
  io.err(`Something went wrong. Try again.${typeof code === "string" ? ` (database error ${code})` : ""}\n`);
  return 1;
}

/** Runs `cli <args>` and returns the exit code. */
export async function runCli(args: string[], io: CliIo, db: () => Database): Promise<number> {
  try {
    const [command, ...rest] = args;
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        if (rest.length > 0) throw new UsageError("help takes no arguments.");
        io.out(help());
        return 0;
      case "settings":
        return await settingsCommand(rest, io, db);
      case "tokens":
        throw new UsageError("Logbook issues no tokens: there is nothing to create.");
      case undefined:
        io.err(help());
        return 2;
      default:
        throw new UsageError("Unknown command.");
    }
  } catch (error) {
    return report(error, io);
  }
}
