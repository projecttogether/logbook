import { DrizzleQueryError } from "drizzle-orm";
import { expect, it } from "vitest";
import { createLogger } from "./logger";

it("writes only selected error fields to the JSON log", () => {
  const lines: string[] = [];
  const logger = createLogger("info", { write: (line) => lines.push(line) });
  const cause = Object.assign(new Error("constraint violation"), {
    detail: "private row data",
    client: { connectionParameters: { password: "private connection data" } },
  });
  const query = new DrizzleQueryError("select $1", ["private bound value"], cause);
  logger.fatal({ err: query }, "migration failed");
  logger.error(
    { err: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }) },
    "directory sync failed",
  );

  expect(lines.map((line) => JSON.parse(line).err)).toEqual([
    { type: "DrizzleQueryError", message: "Failed query: select $1\nparams: [redacted]" },
    { type: "Error", message: "connection refused", code: "ECONNREFUSED" },
  ]);
});

it("redacts implicit messages for both forms of structured error logging", () => {
  const lines: string[] = [];
  const logger = createLogger("info", { write: (line) => lines.push(line) });
  const error = new DrizzleQueryError("select $1", ["private bound value"], new Error("query failed"));
  logger.error({ err: error });
  logger.error(error);

  expect(lines.map((line) => JSON.parse(line).msg)).toEqual(
    Array(2).fill("Failed query: select $1\nparams: [redacted]"),
  );
  expect(lines.join("\n")).not.toContain("private bound value");
});

it("redacts the secrets of an Admin › Integrations body", () => {
  const lines: string[] = [];
  const logger = createLogger("info", { write: (line) => lines.push(line) });
  logger.info(
    {
      body: {
        botToken: "xoxb-private-1",
        url: "https://hooks.example.org/private-path",
        secret: "private-webhook-secret",
        smtp: { password: "private-smtp-password" },
        mailersend: { token: "private-mailersend-token" },
      },
      settings: {
        mailersendToken: "private-mailersend-token",
        webhook: { url: "https://hooks.example.org/private-path", secret: "private-webhook-secret" },
      },
    },
    "body",
  );
  expect(lines.join("\n")).not.toMatch(/private/);
  expect(JSON.parse(lines[0]!).body.smtp.password).toBe("[redacted]");
});
