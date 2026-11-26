import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Database } from "@/lib/db/client";
import type { CliIo } from "./io";
import { runCli } from "./main";

/** Runs the command without a database: these commands must not need one. */
async function cli(
  args: string[],
  db: () => Database = () => {
    throw new Error("no database in this test");
  },
) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    readStdin: async () => "",
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
  };
  const code = await runCli(args, io, db);
  return { code, out: out.join(""), err: err.join("") };
}

describe("cli", () => {
  it("lists the commands, the settings, and where the bodies are documented", async () => {
    const { code, out } = await cli(["help"]);
    expect(code).toBe(0);
    expect(out).toContain("cli settings apply <name> < body.json");
    expect(out).toMatch(/^ {2}slack +Slack: the bot token/m);
    expect(out).toContain("docs/deployment.md#settings-from-the-command-line");
    expect(out).toContain('Logbook issues no tokens, so there is no "cli tokens".');
  });

  it.each([
    [["hunter2-value"]],
    [["settings", "hunter2-value"]],
    [["settings", "show", "hunter2-value"]],
    [["settings", "show", "slack", "hunter2-value"]],
    [["settings", "show", "slack", "--token", "hunter2-value"]],
    [["settings", "show", "slack", "--token=hunter2-value"]],
    [["settings", "apply", "slack", "--id", "hunter2-value"]],
    [["settings", "test", "email", "--to"]],
    [["tokens", "create", "hunter2-value"]],
  ])("refuses %j with exit 2 without repeating it", async (args) => {
    const { code, out, err } = await cli(args);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain('Run "cli help" for the commands.');
    expect(err).not.toContain("hunter2");
  });

  it("has nothing to remove and no webhook test, as the page", async () => {
    expect((await cli(["settings", "remove", "slack"])).err).toContain(
      "slack is a single setting, not a list",
    );
    expect((await cli(["settings", "test", "webhook"])).err).toContain("webhook has no test");
    expect((await cli(["settings", "test", "email"])).err).toContain("Name the address for the test email.");
  });

  it("prints the page's generic message for a database error, not the failed query", async () => {
    const cause = Object.assign(new Error("connection refused"), { code: "08006" });
    const failed = new DrizzleQueryError("select $1", ["hunter2-value"], cause);
    const { code, err } = await cli(["settings", "list"], () => {
      throw failed;
    });
    expect(code).toBe(1);
    expect(err).toBe("Something went wrong. Try again. (database error 08006)\n");
  });
});
