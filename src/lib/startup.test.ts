import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "./logger";
import { validateWebConfigOrExit } from "./startup";

const complete = {
  DATABASE_URL: "postgres://u:p@db:5432/logbook",
  LOGBOOK_BASE_URL: "https://logbook.example.org",
  BETTER_AUTH_SECRET: "x".repeat(32),
  OIDC_ISSUER: "https://auth.example.org/realms/acme",
  OIDC_CLIENT_ID: "logbook",
  OIDC_CLIENT_SECRET: "secret",
  INITIAL_ADMIN_EMAILS: "owner@example.org",
};

describe("validateWebConfigOrExit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ends the web process and names the variable, for the empty LOGBOOK_BASE_URL compose.yaml passes without one", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const fatal = vi.spyOn(logger, "fatal").mockImplementation(() => undefined);
    validateWebConfigOrExit({ ...complete, LOGBOOK_BASE_URL: "" });
    expect(exit).toHaveBeenCalledWith(1);
    const [fields, message] = fatal.mock.calls[0] as unknown as [{ err: Error }, string];
    expect(message).toBe("web failed to start");
    expect(fields.err.message).toContain("- LOGBOOK_BASE_URL: is required");
  });

  it("lets a complete configuration through", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    validateWebConfigOrExit(complete);
    expect(exit).not.toHaveBeenCalled();
  });
});
