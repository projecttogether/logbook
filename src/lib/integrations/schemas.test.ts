import { describe, expect, it } from "vitest";
import { emailInputSchema, fieldErrorsOf, slackInputSchema, webhookInputSchema } from "./schemas";

const errorsOf = (result: { success: boolean; error?: Parameters<typeof fieldErrorsOf>[0] }) =>
  result.success ? {} : fieldErrorsOf(result.error!);

describe("the bodies of Admin › Integrations", () => {
  it("keep an omitted or empty secret, remove it with null, and replace it with text", () => {
    expect(slackInputSchema.parse({}).botToken).toBeUndefined();
    expect(slackInputSchema.parse({ botToken: "  " }).botToken).toBeUndefined();
    expect(slackInputSchema.parse({ botToken: null }).botToken).toBeNull();
    expect(slackInputSchema.parse({ botToken: " xoxb-1 " }).botToken).toBe("xoxb-1");
  });

  it("check a new secret as the page does, without repeating it", () => {
    const result = slackInputSchema.safeParse({ botToken: "xoxp-hunter2-value" });
    expect(errorsOf(result)).toEqual({ botToken: "Enter a bot token that starts with xoxb-." });
    expect(JSON.stringify(result.error)).not.toContain("hunter2");
    expect(
      errorsOf(webhookInputSchema.safeParse({ url: "https://hooks.example.org", secret: "short" })),
    ).toEqual({
      secret: "Use at least 16 characters.",
    });
  });

  it("refuse unknown fields without naming them: a field name could be a pasted secret", () => {
    const result = slackInputSchema.safeParse({ botToken: "xoxb-1", "hunter2-value": true });
    expect(errorsOf(result)).toEqual({
      body: "Unknown field (not shown). The fields are botToken and channelId.",
    });
    expect(JSON.stringify(fieldErrorsOf(result.error!))).not.toContain("hunter2");
    expect(errorsOf(emailInputSchema.safeParse({ provider: "smtp", smtp: { pass: "x" } }))).toEqual({
      smtp: "Unknown field (not shown). The fields are host, port, security, username, and password.",
    });
  });

  it("take what `show` prints back as a body", () => {
    const shown = {
      state: "set",
      provider: "smtp",
      fromAddress: "logbook@example.org",
      fromName: "",
      smtp: {
        host: "mail.example.org",
        port: 587,
        security: "starttls",
        username: "u",
        passwordSaved: true,
        passwordHint: "…abcd",
      },
      mailersend: { tokenSaved: false, tokenHint: null },
      warnings: [],
    };
    const parsed = emailInputSchema.parse(shown);
    expect(parsed.smtp).toMatchObject({ host: "mail.example.org", port: 587 });
    expect(parsed.smtp.password).toBeUndefined();
  });

  it("read a port typed into the form, and a channel ID, not a name", () => {
    expect(emailInputSchema.parse({ provider: "smtp", smtp: { port: "465" } }).smtp.port).toBe(465);
    expect(errorsOf(emailInputSchema.safeParse({ provider: "smtp", smtp: { port: "x" } }))).toEqual({
      "smtp.port": "Enter a port between 1 and 65535.",
    });
    expect(slackInputSchema.parse({ channelId: " C0123456789 " }).channelId).toBe("C0123456789");
    expect(slackInputSchema.parse({ channelId: "" }).channelId).toBeNull();
    expect(errorsOf(slackInputSchema.safeParse({ channelId: "#logbook" }))).toEqual({
      channelId: "Enter the channel's ID (C…), not its name.",
    });
  });

  it("turn the webhook off with a null URL, keep one left out or empty, and take only http and https, without repeating it", () => {
    expect(webhookInputSchema.parse({ url: null }).url).toBeNull();
    expect(webhookInputSchema.parse({}).url).toBeUndefined();
    expect(webhookInputSchema.parse({ url: " " }).url).toBeUndefined();
    expect(webhookInputSchema.parse({ url: " https://hooks.example.org/a?b=c " }).url).toBe(
      "https://hooks.example.org/a?b=c",
    );
    const result = webhookInputSchema.safeParse({ url: "ftp://hooks.example.org/hunter2" });
    expect(errorsOf(result)).toEqual({ url: "Enter an http:// or https:// URL." });
    expect(JSON.stringify(result.error)).not.toContain("hunter2");
  });

  it("name a body that is not an object", () => {
    expect(errorsOf(webhookInputSchema.safeParse([]))).toEqual({ body: expect.any(String) });
  });
});
