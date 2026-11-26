import { createServer, type AddressInfo } from "node:net";
import { eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import { appSetting, auditEvent, workerHeartbeat } from "@/lib/db/schema";
import { z } from "zod";
import { createWebhookClient } from "@/lib/webhooks/client";
import { deriveSealingKey, seal } from "./crypto";
import { createIntegrationsRuntime } from "./runtime";
import { IntegrationError, integrationViews, saveIntegration, testEmail, testSlack } from "./service";
import { sealWebhookUrl } from "./start";

const testDb = connectTestDatabase();
const { db } = testDb;
let amy: { personId: string };

const KEY = deriveSealingKey("k".repeat(32));
const OTHER_KEY = deriveSealingKey("o".repeat(32));
const TOKEN = "xoxb-integration-secret-7f3a";
const PASSWORD = "smtp-secret-password-9c1d";
const SIGNING = "webhook-signing-secret-2b8e";
const HOOK_SECRETS = ["user-4d1e", "pass-6f2a", "path-token-8b3c", "query-token-0d5f"] as const;
const HOOK = `https://${HOOK_SECRETS[0]}:${HOOK_SECRETS[1]}@hooks.example.org:8443/${HOOK_SECRETS[2]}?key=${HOOK_SECRETS[3]}`;
const ORIGIN = "https://hooks.example.org:8443";

function expectHidden(...values: unknown[]) {
  const text = values.map((value) => JSON.stringify(value)).join();
  for (const secret of HOOK_SECRETS) expect(text).not.toContain(secret);
}

beforeEach(async () => {
  await testDb.reset();
  const seed = await seedDirectory(db);
  amy = { personId: seed.people.amy.id };
  vi.stubEnv("BETTER_AUTH_SECRET", "k".repeat(32));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(() => testDb.close());

const rows = async () =>
  Object.fromEntries((await db.select().from(appSetting)).map((row) => [row.key, row.value]));
const audits = async () =>
  db.select().from(auditEvent).where(like(auditEvent.action, "settings.%")).orderBy(auditEvent.id);

/** A stand-in for Slack's Web API and MailerSend, as the transport tests use. */
function fakeFetch(answers: Record<string, unknown>) {
  const calls: { url: string; body: unknown; authorization: string | undefined }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      calls.push({
        url: target,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
      });
      const answer = Object.entries(answers).find(([prefix]) => target.startsWith(prefix))?.[1] ?? {
        ok: true,
      };
      return new Response(typeof answer === "number" ? "" : JSON.stringify(answer), {
        status: typeof answer === "number" ? answer : 200,
      });
    }),
  );
  return calls;
}

describe("saving on the page and with the command", () => {
  it("seals the secret, shows only its hint, and records who changed which fields", async () => {
    const { message, view } = await saveIntegration(
      db,
      "slack",
      { botToken: TOKEN, channelId: "C0123456789" },
      amy,
      KEY,
    );
    expect(message).toBe("Saved Slack.");
    expect(view).toEqual({
      state: "set",
      botTokenSaved: true,
      botTokenHint: "…7f3a",
      channelId: "C0123456789",
      warnings: [],
    });
    expect(JSON.stringify(await rows())).not.toContain(TOKEN);
    const [event] = await audits();
    expect(event).toMatchObject({
      actorId: amy.personId,
      action: "settings.slack_changed",
      payload: { changed: ["botToken", "channelId"] },
    });
    expect(JSON.stringify(event)).not.toContain(TOKEN);
  });

  it("keeps a secret the body leaves out, removes it with null, and replaces every other field", async () => {
    await saveIntegration(db, "slack", { botToken: TOKEN, channelId: "C0123456789" }, amy, KEY);
    const kept = await saveIntegration(db, "slack", { botToken: "", channelId: null }, amy, KEY);
    expect(kept.view).toMatchObject({ botTokenSaved: true, botTokenHint: "…7f3a", channelId: null });
    const removed = await saveIntegration(db, "slack", { botToken: null }, amy, KEY);
    expect(removed.view).toMatchObject({ state: "not set", botTokenSaved: false });
  });

  it("refuses a body as the page does, and saves nothing", async () => {
    const refused = await saveIntegration(
      db,
      "email",
      { provider: "smtp", fromAddress: "nope", smtp: { username: "u" } },
      amy,
      KEY,
    ).catch((e) => e);
    expect(refused).toBeInstanceOf(IntegrationError);
    expect(refused.message).toBe("Check the highlighted fields.");
    expect(refused.fieldErrors).toEqual({
      fromAddress: "Enter an email address.",
      "smtp.host": "Enter the mail server.",
      "smtp.password": "Enter the password for this user name.",
    });
    await expect(
      saveIntegration(db, "email", { provider: "mailersend", fromAddress: "logbook@example.org" }, amy, KEY),
    ).rejects.toMatchObject({
      fieldErrors: { "mailersend.token": "Enter the API token." },
    });
    await expect(
      saveIntegration(db, "webhook", { url: "https://hooks.example.org/logbook" }, amy, KEY),
    ).rejects.toMatchObject({
      fieldErrors: { secret: "Enter a signing secret of at least 16 characters." },
    });
    expect(await rows()).toEqual({});
    expect(await audits()).toEqual([]);
  });

  it("saves SMTP with its password, and switching the provider keeps the other's fields", async () => {
    const body = {
      provider: "smtp",
      fromAddress: "logbook@example.org",
      fromName: "",
      smtp: { host: "mail.example.org", port: 465, security: "tls", username: "logbook", password: PASSWORD },
    };
    const saved = await saveIntegration(db, "email", body, amy, KEY);
    expect(saved.view).toMatchObject({
      state: "set",
      smtp: { host: "mail.example.org", port: 465, passwordSaved: true, passwordHint: "…9c1d" },
    });
    const off = await saveIntegration(
      db,
      "email",
      { ...body, provider: "none", smtp: { ...body.smtp, password: undefined } },
      amy,
      KEY,
    );
    expect(off.view).toMatchObject({
      state: "not set",
      smtp: { host: "mail.example.org", passwordSaved: true },
    });
    expect(JSON.stringify(await rows())).not.toContain(PASSWORD);
  });

  it("asks for the SMTP password again before it would go to another server or travel less protected", async () => {
    const body = {
      provider: "smtp",
      fromAddress: "logbook@example.org",
      smtp: {
        host: "mail.example.org",
        port: 587,
        security: "starttls",
        username: "logbook",
        password: PASSWORD,
      },
    };
    await saveIntegration(db, "email", body, amy, KEY);
    const kept = { ...body, smtp: { ...body.smtp, password: undefined } };
    const elsewhere = { ...kept, smtp: { ...kept.smtp, host: "mail.attacker.example" } };
    await expect(saveIntegration(db, "email", elsewhere, amy, KEY)).rejects.toMatchObject({
      fieldErrors: { "smtp.password": "Enter the password again: the mail server changed." },
    });
    // Also while another provider is chosen, which would carry the new server over unchecked.
    await expect(
      saveIntegration(db, "email", { ...elsewhere, provider: "none" }, amy, KEY),
    ).rejects.toMatchObject({
      fieldErrors: { "smtp.password": "Enter the password again: the mail server changed." },
    });
    await expect(
      saveIntegration(db, "email", { ...kept, smtp: { ...kept.smtp, security: "auto" } }, amy, KEY),
    ).rejects.toMatchObject({
      fieldErrors: { "smtp.password": "Enter the password again: the encryption is weaker now." },
    });
    // A body without `smtp` keeps the saved SMTP settings, as the documented {"provider": "none"} does.
    expect((await saveIntegration(db, "email", { provider: "none" }, amy, KEY)).view).toMatchObject({
      state: "not set",
      smtp: { host: "mail.example.org", passwordSaved: true },
    });
    expect(
      (
        await saveIntegration(
          db,
          "email",
          {
            provider: "mailersend",
            fromAddress: "logbook@example.org",
            mailersend: { token: "mlsn.token-1234" },
          },
          amy,
          KEY,
        )
      ).view,
    ).toMatchObject({ state: "set", smtp: { host: "mail.example.org", passwordSaved: true } });
    // The same server and protection keep it; a new password or none at all may go anywhere.
    expect(
      (
        await saveIntegration(
          db,
          "email",
          { ...kept, smtp: { ...kept.smtp, port: 465, security: "tls" } },
          amy,
          KEY,
        )
      ).view.state,
    ).toBe("set");
    expect(
      (
        await saveIntegration(
          db,
          "email",
          { ...elsewhere, smtp: { ...elsewhere.smtp, password: "a-new-password-0000" } },
          amy,
          KEY,
        )
      ).view,
    ).toMatchObject({
      smtp: { host: "mail.attacker.example", passwordHint: "…0000" },
    });
  });

  it("waits for another writer at the same time, also before the setting has a row", async () => {
    const client = await testDb.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('logbook.integrations'))");
      const save = saveIntegration(db, "slack", { channelId: "C0123456789" }, amy, KEY);
      await new Promise((resolve) => setTimeout(resolve, 200));
      // What it writes while it holds the lock.
      await client.query("insert into app_setting (key, value) values ('slack', $1)", [
        JSON.stringify({ botToken: { sealed: "v1.other.value", hint: "…7f3a" }, channelId: null }),
      ]);
      await client.query("commit");
      expect((await save).view).toMatchObject({
        botTokenSaved: true,
        botTokenHint: "…7f3a",
        channelId: "C0123456789",
      });
    } finally {
      client.release();
    }
  });

  it("cannot store a new secret without BETTER_AUTH_SECRET, but changes other fields", async () => {
    await saveIntegration(db, "slack", { botToken: TOKEN }, amy, KEY);
    await expect(
      saveIntegration(db, "slack", { botToken: "xoxb-other-token-1234" }, amy, null),
    ).rejects.toMatchObject({
      message: expect.stringContaining("no BETTER_AUTH_SECRET"),
      fieldErrors: { botToken: "Not saved: this process cannot seal secrets." },
    });
    const { view } = await saveIntegration(db, "slack", { channelId: "C0123456789" }, amy, null);
    expect(view).toMatchObject({ botTokenHint: "…7f3a", channelId: "C0123456789" });
  });

  it("says when a saved secret cannot be read with the current BETTER_AUTH_SECRET", async () => {
    const again = "The saved value cannot be read with the current BETTER_AUTH_SECRET: enter it again.";
    await saveIntegration(db, "webhook", { url: HOOK, secret: SIGNING }, amy, OTHER_KEY);
    const views = await integrationViews(db);
    expect(views.webhook).toMatchObject({ state: "incomplete", urlSaved: true, urlHint: ORIGIN });
    expect(views.webhook.warnings).toEqual([`The URL: ${again}`, `The signing secret: ${again}`]);
    await expect(saveIntegration(db, "webhook", { url: HOOK }, amy, KEY)).rejects.toMatchObject({
      fieldErrors: { secret: again },
    });
    await expect(saveIntegration(db, "webhook", { secret: SIGNING }, amy, KEY)).rejects.toMatchObject({
      fieldErrors: { url: again },
    });
    expect(
      (await saveIntegration(db, "webhook", { url: HOOK, secret: SIGNING }, amy, KEY)).view,
    ).toMatchObject({ state: "set", warnings: [] });
  });
});

describe("the webhook's URL", () => {
  const worker = () =>
    createIntegrationsRuntime({ db: () => db, key: KEY, mode: "live", baseUrl: "https://logbook.example" });
  const savedAsEarlier = async () => {
    const value = { url: HOOK, secret: { sealed: seal(KEY, "webhook.secret", SIGNING), hint: "…2b8e" } };
    await db.insert(appSetting).values({ key: "webhook", value, updatedById: amy.personId });
  };

  it("is sealed; the view, the audit event, and errors name only its server", async () => {
    const { view } = await saveIntegration(db, "webhook", { url: HOOK, secret: SIGNING }, amy, KEY);
    expect(view).toEqual({
      state: "set",
      urlSaved: true,
      urlHint: ORIGIN,
      secretSaved: true,
      secretHint: "…2b8e",
      warnings: [],
    });
    const [event] = await audits();
    expect(event).toMatchObject({
      action: "settings.webhook_changed",
      payload: { changed: ["url", "secret"] },
    });
    const settings = (await worker().webhook())!;
    expect(settings).toEqual({ url: HOOK, secret: SIGNING });
    const failed = await createWebhookClient({ url: settings.url!, secret: SIGNING })
      .send({} as never)
      .catch((e: Error) => e.message);
    expect(failed).toContain(ORIGIN);
    expectHidden(view, event, failed, await rows(), await integrationViews(db));
  });

  it("is kept when left out or empty, and null turns the webhook off", async () => {
    await saveIntegration(db, "webhook", { url: HOOK, secret: SIGNING }, amy, KEY);
    expect(
      (await saveIntegration(db, "webhook", { secret: "another-signing-secret-1234" }, amy, KEY)).view,
    ).toMatchObject({ state: "set", urlHint: ORIGIN, secretHint: "…1234" });
    expect((await saveIntegration(db, "webhook", { url: "" }, amy, KEY)).view).toMatchObject({
      state: "set",
      urlHint: ORIGIN,
    });
    expect((await worker().webhook())?.url).toBe(HOOK);
    expect((await saveIntegration(db, "webhook", { url: null }, amy, KEY)).view).toMatchObject({
      state: "not set",
      urlSaved: false,
      urlHint: null,
      secretSaved: true,
    });
    expect(await worker().webhook()).toBeNull();
  });

  it("saved as plain text by an earlier version, works at once and is sealed once at the start of a process", async () => {
    await savedAsEarlier();
    const runtime = worker();
    expect(await runtime.webhook()).toEqual({ url: HOOK, secret: SIGNING });
    const before = (await integrationViews(db)).webhook;
    expect(before).toMatchObject({ state: "set", urlSaved: true, urlHint: ORIGIN, secretHint: "…2b8e" });
    expectHidden(before);

    expect((await Promise.all([sealWebhookUrl(db, KEY), sealWebhookUrl(db, KEY)])).sort()).toEqual([
      false,
      true,
    ]);
    const sealed = await rows();
    expectHidden(sealed, await audits());
    expect(await sealWebhookUrl(db, KEY)).toBe(false);
    expect(await rows()).toEqual(sealed);
    // The same settings, also for a worker that read the plain URL before.
    expect(await runtime.webhook()).toEqual({ url: HOOK, secret: SIGNING });
    expect((await integrationViews(db)).webhook).toEqual(before);
    const [row] = await db.select().from(appSetting).where(eq(appSetting.key, "webhook"));
    expect(row!.updatedById).toBe(amy.personId);
  });

  it("is off for that earlier version after a rollback: it takes the sealed URL for none", async () => {
    await savedAsEarlier();
    await sealWebhookUrl(db, KEY);
    // The webhook setting as the earlier version read it (src/lib/integrations/store.ts then).
    const schema = z.object({
      url: z.string().nullable().catch(null),
      secret: z.object({ sealed: z.string(), hint: z.string().nullable() }).nullable().catch(null),
    });
    expect(schema.parse((await rows()).webhook)).toMatchObject({ url: null, secret: { hint: "…2b8e" } });
  });
});

describe("the test buttons", () => {
  it("check the Slack token and post to the channel, with the saved token", async () => {
    vi.stubEnv("NOTIFICATION_TRANSPORT", "live");
    await saveIntegration(db, "slack", { botToken: TOKEN, channelId: "C0123456789" }, amy, KEY);
    const calls = fakeFetch({
      "https://slack.com/api/auth.test": { ok: true, team: "Acme", user: "logbook" },
    });
    expect(await testSlack(db, KEY)).toEqual({
      ok: true,
      message:
        "Slack accepted the token (workspace Acme, bot logbook), and Logbook posted a test message to the channel.",
    });
    expect(calls.map((call) => [call.url, call.authorization])).toEqual([
      ["https://slack.com/api/auth.test", `Bearer ${TOKEN}`],
      ["https://slack.com/api/chat.postMessage", `Bearer ${TOKEN}`],
    ]);
    expect(calls[1]!.body).toMatchObject({ channel: "C0123456789" });

    fakeFetch({ "https://slack.com/api/auth.test": { ok: false, error: "invalid_auth" } });
    expect(await testSlack(db, KEY)).toEqual({
      ok: false,
      message: "Slack refused: Slack auth.test: invalid_auth",
    });
  });

  it("send a test email through the saved provider, and refuse a bad address", async () => {
    vi.stubEnv("NOTIFICATION_TRANSPORT", "live");
    await saveIntegration(
      db,
      "email",
      {
        provider: "mailersend",
        fromAddress: "logbook@example.org",
        mailersend: { token: "mlsn.test-token-5e6f" },
      },
      amy,
      KEY,
    );
    const calls = fakeFetch({ "https://api.mailersend.com": 202 });
    expect(await testEmail(db, { to: "amy@example.org" }, KEY)).toEqual({
      ok: true,
      message: "Sent a test email to amy@example.org.",
    });
    expect(calls[0]).toMatchObject({
      authorization: "Bearer mlsn.test-token-5e6f",
      body: { to: [{ email: "amy@example.org" }], from: { name: "Logbook" } },
    });
    await expect(testEmail(db, { to: "nope" }, KEY)).rejects.toMatchObject({
      fieldErrors: { to: "Enter an email address." },
    });
    fakeFetch({ "https://api.mailersend.com": 401 });
    expect(await testEmail(db, { to: "amy@example.org" }, KEY)).toEqual({
      ok: false,
      message: "The test email could not be sent: MailerSend: HTTP 401",
    });
  });

  it("show what the mail server answered to a test email, without the login, and only a code of what is no mail server", async () => {
    vi.stubEnv("NOTIFICATION_TRANSPORT", "live");
    let greeting = "220 mail.example.org ready";
    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      socket.write(`${greeting}\r\n`);
      socket.on("data", (data) => {
        const line = data.toString().trim();
        if (line.startsWith("EHLO") && !greeting.includes("FTP"))
          socket.write("250-mail.example.org\r\n250 AUTH PLAIN\r\n");
        else if (line.startsWith("AUTH"))
          socket.write(
            `535-5.7.8 Login refused for logbook\r\n535 5.7.8 ${line.split(" ")[2]} (${PASSWORD})\r\n`,
          );
        else socket.write("500 what?\r\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const smtp = {
        host: "127.0.0.1",
        port: (server.address() as AddressInfo).port,
        security: "none",
        username: "logbook",
        password: PASSWORD,
      };
      await saveIntegration(
        db,
        "email",
        { provider: "smtp", fromAddress: "sender@example.org", smtp },
        amy,
        KEY,
      );
      expect(await testEmail(db, { to: "amy@example.org" }, KEY)).toEqual({
        ok: false,
        message:
          'The test email could not be sent: the mail server answered "535-5.7.8 Login refused for *** 535 5.7.8 *** (***)".',
      });
      for (greeting of ["SSH-2.0-OpenSSH_10", "220 FTP server ready"]) {
        expect(await testEmail(db, { to: "amy@example.org" }, KEY)).toEqual({
          ok: false,
          message: "The test email could not be sent (EPROTOCOL).",
        });
      }
    } finally {
      server.close();
    }
  });

  it("only log in development, and say what is missing", async () => {
    expect(await testSlack(db, KEY)).toEqual({ ok: false, message: "Save a bot token first." });
    expect(await testEmail(db, { to: "amy@example.org" }, KEY)).toMatchObject({
      ok: false,
      message: expect.stringContaining("Email is not set up"),
    });
    await saveIntegration(db, "slack", { botToken: TOKEN }, amy, KEY);
    expect(await testSlack(db, KEY)).toEqual({
      ok: true,
      message: expect.stringContaining("NOTIFICATION_TRANSPORT is console"),
    });
  });
});

describe("the worker", () => {
  it("picks up a change without a restart", async () => {
    vi.stubEnv("NOTIFICATION_TRANSPORT", "live");
    const runtime = createIntegrationsRuntime({
      db: () => db,
      key: KEY,
      mode: "live",
      baseUrl: "https://logbook.example",
    });
    expect((await runtime.transports()).slack).toBeUndefined();
    expect(await runtime.webhook()).toBeNull();
    await saveIntegration(db, "slack", { botToken: TOKEN, channelId: "C0123456789" }, amy, KEY);
    await saveIntegration(
      db,
      "webhook",
      { url: "https://hooks.example.org/logbook", secret: SIGNING },
      amy,
      KEY,
    );
    expect((await runtime.transports()).slack?.mode).toBe("live");
    expect(await runtime.webhook()).toEqual({ url: "https://hooks.example.org/logbook", secret: SIGNING });
    expect(runtime.channels()).toEqual({
      slack: "live",
      slackChannel: "live",
      email: "off",
      webhook: "live",
      withoutKey: false,
    });
  });

  it("says when it has no BETTER_AUTH_SECRET (a worker started without it), and then reads no secret", async () => {
    const runtime = createIntegrationsRuntime({
      db: () => db,
      key: null,
      mode: "live",
      baseUrl: "https://logbook.example",
    });
    await saveIntegration(db, "slack", { botToken: TOKEN }, amy, KEY);
    await saveIntegration(db, "webhook", { url: HOOK, secret: SIGNING }, amy, KEY);
    // On, but unreadable: messages are tried again, not skipped.
    expect((await runtime.transports()).slack!.mode).toBe("unreadable");
    expect(await runtime.webhook()).toBeNull();
    expect(runtime.channels()).toMatchObject({ slack: "off", webhook: "off", withoutKey: true });
    await db
      .insert(workerHeartbeat)
      .values({ workerId: "w1", startedAt: new Date(), beatAt: new Date(), channels: runtime.channels() });
    expect((await integrationViews(db)).slack.warnings).toEqual([
      'The worker has no BETTER_AUTH_SECRET, so it cannot read the secrets saved here. Pass it to the worker, as compose.yaml does (docs/deployment.md, "Operations").',
    ]);
  });
});
