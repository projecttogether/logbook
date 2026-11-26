import { spawn } from "node:child_process";
import path from "node:path";
import { like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTestDatabase } from "../../tests/integration/db";
import { appSetting, auditEvent } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { CliIo } from "./io";
import { runCli } from "./main";

/*
 * `cli settings` against the database: it does what Admin › Integrations
 * does (the same answers, checks, and audit events), as the operator, and no
 * secret reaches an argument, stdout, stderr, or the log.
 */

const testDb = connectTestDatabase();
const { db } = testDb;

const TOKEN = "xoxb-cli-secret-value-7f3a";
const SIGNING = "cli-webhook-signing-secret-4c2d";
const HOOK_TOKEN = "cli-webhook-url-token-9e8f";
const HOOK = `https://hooks.example.org/${HOOK_TOKEN}?key=${HOOK_TOKEN}`;

async function cli(args: string[], stdin: unknown = "") {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    readStdin: async () => (typeof stdin === "string" ? stdin : JSON.stringify(stdin)),
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
  };
  const code = await runCli(args, io, () => db);
  return { code, out: out.join(""), err: err.join("") };
}

const logged: unknown[][] = [];
beforeAll(() => {
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => void logged.push(args)) as never);
  }
});
beforeEach(async () => {
  await testDb.reset();
  vi.stubEnv("BETTER_AUTH_SECRET", "c".repeat(32));
});
afterEach(() => {
  // Whatever a test logged, no secret is in it.
  const text = JSON.stringify(logged, (_key, value: unknown) =>
    value instanceof Error ? `${value.message} ${value.stack}` : value,
  );
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(SIGNING);
  expect(text).not.toContain(HOOK_TOKEN);
  logged.length = 0;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await testDb.close();
});

describe("cli settings", () => {
  it("applies a body as the page does: sealed in the database, a hint in show and list, the operator in the audit log", async () => {
    const applied = await cli(["settings", "apply", "slack"], { botToken: TOKEN, channelId: "C0123456789" });
    expect(applied).toEqual({
      code: 0,
      err: "Saved Slack.\n",
      out: `${JSON.stringify({ state: "set", botTokenSaved: true, botTokenHint: "…7f3a", channelId: "C0123456789", warnings: [] }, null, 2)}\n`,
    });
    const shown = await cli(["settings", "show", "slack"]);
    expect(JSON.parse(shown.out)).toEqual(JSON.parse(applied.out));

    const listed = await cli(["settings", "list"]);
    expect(listed.code).toBe(0);
    expect(listed.out).toBe(
      [
        "slack    set         token …7f3a, channel C0123456789",
        "email    not set",
        "webhook  not set",
        "",
      ].join("\n"),
    );
    const rows = JSON.parse((await cli(["settings", "list", "--json"])).out);
    expect(rows[0]).toEqual({
      name: "slack",
      state: "set",
      hints: ["token …7f3a", "channel C0123456789"],
      warnings: [],
    });

    const stored = await db.select().from(appSetting);
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    const [event] = await db.select().from(auditEvent).where(like(auditEvent.action, "settings.%"));
    expect(event).toMatchObject({
      actorId: null,
      action: "settings.slack_changed",
      payload: { actor: "operator", command: "cli settings apply slack", changed: ["botToken", "channelId"] },
    });
    for (const result of [applied, shown, listed]) expect(result.out + result.err).not.toContain(TOKEN);
  });

  it("takes back what show prints, keeping the saved secrets, and shows only the server of the webhook's URL", async () => {
    const applied = await cli(["settings", "apply", "webhook"], { url: HOOK, secret: SIGNING });
    const shown = await cli(["settings", "show", "webhook"]);
    const again = await cli(["settings", "apply", "webhook"], shown.out);
    expect(again.code, again.err).toBe(0);
    for (const result of [applied, shown, again]) {
      expect(JSON.parse(result.out)).toEqual({
        state: "set",
        urlSaved: true,
        urlHint: "https://hooks.example.org",
        secretSaved: true,
        secretHint: "…4c2d",
        warnings: [],
      });
    }
    const listed = await cli(["settings", "list"]);
    expect(listed.out).toContain("webhook  set         url https://hooks.example.org, secret …4c2d\n");
    const listedJson = await cli(["settings", "list", "--json"]);
    const refused = await cli(["settings", "apply", "webhook"], { url: HOOK, secret: "short" });
    expect(refused.code).toBe(1);
    const stored = await db.select().from(appSetting);
    const audited = await db.select().from(auditEvent);
    const outputs = [applied, shown, again, listed, listedJson, refused].map(
      (result) => result.out + result.err,
    );
    expect(JSON.stringify([outputs, stored, audited])).not.toContain(HOOK_TOKEN);
  });

  it("refuses a body with the page's message and exit 1, and a body that is not JSON with exit 2", async () => {
    const refused = await cli(["settings", "apply", "webhook"], {
      url: "https://hooks.example.org/logbook",
      secret: "short",
    });
    expect(refused).toEqual({
      code: 1,
      out: "",
      err: "Check the highlighted fields.\n  secret: Use at least 16 characters.\n",
    });
    const missing = await cli(["settings", "apply", "email"], {
      provider: "smtp",
      fromAddress: "logbook@example.org",
    });
    expect(missing).toMatchObject({
      code: 1,
      err: "Check the highlighted fields.\n  smtp.host: Enter the mail server.\n",
    });
    const unknown = await cli(["settings", "apply", "slack"], { [TOKEN]: true });
    expect(unknown).toMatchObject({
      code: 1,
      err: "Check the highlighted fields.\n  body: Unknown field (not shown). The fields are botToken and channelId.\n",
    });
    const notJson = await cli(["settings", "apply", "slack"], `{ "botToken": "${TOKEN}"`);
    expect(notJson.code).toBe(2);
    expect(notJson.err).toContain("The body on stdin is not JSON.");
    for (const result of [refused, unknown, notJson]) expect(result.out + result.err).not.toContain(TOKEN);
    expect(await db.select().from(appSetting)).toEqual([]);
  });

  it("tests Slack and email as the page's buttons do", async () => {
    vi.stubEnv("NOTIFICATION_TRANSPORT", "live");
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        requests.push(String(url));
        if (String(url).includes("auth.test")) return Response.json({ ok: false, error: "invalid_auth" });
        return new Response("", { status: 202 });
      }),
    );
    await cli(["settings", "apply", "slack"], { botToken: TOKEN });
    const slack = await cli(["settings", "test", "slack"]);
    expect(slack).toEqual({
      code: 1,
      out: `${JSON.stringify({ ok: false, message: "Slack refused: Slack auth.test: invalid_auth" }, null, 2)}\n`,
      err: "Slack refused: Slack auth.test: invalid_auth\n",
    });

    await cli(["settings", "apply", "email"], {
      provider: "mailersend",
      fromAddress: "logbook@example.org",
      mailersend: { token: "mlsn.cli-token-0000" },
    });
    const email = await cli(["settings", "test", "email", "--to", "ops@example.org"]);
    expect(email).toMatchObject({ code: 0, err: "" });
    expect(JSON.parse(email.out)).toEqual({ ok: true, message: "Sent a test email to ops@example.org." });
    expect(requests).toEqual(["https://slack.com/api/auth.test", "https://api.mailersend.com/v1/email"]);
  });

  it("cannot store a secret in a process without BETTER_AUTH_SECRET", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    const refused = await cli(["settings", "apply", "slack"], { botToken: TOKEN });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("This process has no BETTER_AUTH_SECRET");
    expect(await db.select().from(appSetting)).toEqual([]);
  });
});

describe("cli as a process", () => {
  const root = path.resolve(import.meta.dirname, "../..");

  function run(args: string[], stdin: string): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/cli/entry.ts", ...args], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: process.env.TEST_DATABASE_URL,
          BETTER_AUTH_SECRET: "c".repeat(32),
          NODE_ENV: "production",
          LOG_LEVEL: "info",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out, err }));
      child.stdin.end(stdin);
    });
  }

  it("reads the body from a pipe, prints only the result on stdout, logs to stderr, and exits", async () => {
    const applied = await run(
      ["settings", "apply", "webhook"],
      JSON.stringify({ url: HOOK, secret: SIGNING }),
    );
    expect(applied.code, applied.err).toBe(0);
    expect(JSON.parse(applied.out)).toMatchObject({ state: "set", secretHint: "…4c2d" });
    expect(applied.err).toBe("Saved the webhook.\n");
    expect(applied.out + applied.err).not.toContain(SIGNING);
    expect(applied.out + applied.err).not.toContain(HOOK_TOKEN);

    const failed = await run(["settings", "list"], "");
    expect(failed.code).toBe(0);
    expect(failed.out).toMatch(/^webhook +set +url https:\/\/hooks\.example\.org, secret …4c2d$/m);
  }, 30_000);
});
