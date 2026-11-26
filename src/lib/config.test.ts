import { describe, expect, it } from "vitest";
import {
  ConfigError,
  parseAuthConfig,
  parseDirectoryConfig,
  parseErrorReportingConfig,
  parseNotificationConfig,
  parseSealingConfig,
  parseVersionConfig,
  validateWebConfig,
  validateWorkerConfig,
} from "./config";

const auth = {
  LOGBOOK_BASE_URL: "https://logbook.example.org/",
  BETTER_AUTH_SECRET: "x".repeat(32),
  OIDC_ISSUER: "https://auth.example.org/realms/acme/",
  OIDC_CLIENT_ID: "logbook",
  OIDC_CLIENT_SECRET: "secret",
};

const keycloakDirectory = {
  DIRECTORY: "keycloak",
  OIDC_ISSUER: "https://auth.example.org/realms/acme",
  OIDC_CLIENT_ID: "logbook",
  OIDC_CLIENT_SECRET: "secret",
  KEYCLOAK_ACCESS_GROUP: "/logbook",
  KEYCLOAK_ADMIN_GROUP: "/logbook-admins",
  KEYCLOAK_TEAMS_GROUP: "/teams",
};

const manualDirectory = { INITIAL_ADMIN_EMAILS: "owner@example.org" };

describe("parseAuthConfig", () => {
  it("strips trailing slashes from URLs and defaults the scopes", () => {
    const config = parseAuthConfig(auth);
    expect(config.LOGBOOK_BASE_URL).toBe("https://logbook.example.org");
    expect(config.OIDC_ISSUER).toBe("https://auth.example.org/realms/acme");
    expect(config.OIDC_SCOPES).toBe("openid profile email");
  });

  it("treats blank values as missing", () => {
    expect(() => parseAuthConfig({ ...auth, OIDC_CLIENT_SECRET: "  " })).toThrow(/OIDC_CLIENT_SECRET/);
  });

  it("accepts the previous base URL variable for web and worker", () => {
    const legacy = { LOGBUCH_BASE_URL: "https://existing.example.org/" };
    const config = { ...auth, ...legacy, LOGBOOK_BASE_URL: " " };
    expect(parseAuthConfig(config).LOGBOOK_BASE_URL).toBe("https://existing.example.org");
    expect(parseNotificationConfig(legacy).LOGBOOK_BASE_URL).toBe("https://existing.example.org");
    expect(parseAuthConfig({ ...auth, ...legacy }).LOGBOOK_BASE_URL).toBe("https://logbook.example.org");
  });

  it("requires a long secret, and not the example one in production", () => {
    expect(() => parseAuthConfig({ ...auth, BETTER_AUTH_SECRET: "short" })).toThrow(/at least 32/);
    const example = { ...auth, BETTER_AUTH_SECRET: "development-secret-development-secret" };
    expect(() => parseAuthConfig(example)).not.toThrow();
    expect(() => parseAuthConfig({ ...example, NODE_ENV: "production" })).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("has no default identity provider", () => {
    expect(() => parseAuthConfig({ ...auth, OIDC_ISSUER: undefined })).toThrow(/OIDC_ISSUER/);
  });

  it("trusts the provider's email addresses only when told to", () => {
    expect(parseAuthConfig(auth).OIDC_TRUST_EMAIL).toBe(false);
    expect(parseAuthConfig({ ...auth, OIDC_TRUST_EMAIL: "true" }).OIDC_TRUST_EMAIL).toBe(true);
    expect(parseAuthConfig({ ...auth, OIDC_TRUST_EMAIL: " " }).OIDC_TRUST_EMAIL).toBe(false);
    expect(() => parseAuthConfig({ ...auth, OIDC_TRUST_EMAIL: "yes" })).toThrow(/OIDC_TRUST_EMAIL/);
  });
});

describe("parseDirectoryConfig", () => {
  it("is manual by default and needs the first admins, or nobody could ever get in", () => {
    expect(() => parseDirectoryConfig({})).toThrow(/INITIAL_ADMIN_EMAILS: is required with DIRECTORY=manual/);
    expect(() => parseDirectoryConfig({ INITIAL_ADMIN_EMAILS: " , " })).toThrow(/INITIAL_ADMIN_EMAILS/);
    expect(
      parseDirectoryConfig({ INITIAL_ADMIN_EMAILS: "Ada@Example.org, bob@example.org;carl@example.org" }),
    ).toEqual({
      DIRECTORY: "manual",
      INITIAL_ADMIN_EMAILS: ["ada@example.org", "bob@example.org", "carl@example.org"],
    });
    expect(() => parseDirectoryConfig({ INITIAL_ADMIN_EMAILS: "not-an-email" })).toThrow(
      /INITIAL_ADMIN_EMAILS/,
    );
  });

  it("uses the login client for the Keycloak directory unless it has its own", () => {
    expect(parseDirectoryConfig(keycloakDirectory)).toMatchObject({
      DIRECTORY: "keycloak",
      KEYCLOAK_CLIENT_ID: "logbook",
      KEYCLOAK_CLIENT_SECRET: "secret",
      KEYCLOAK_ACCESS_GROUP: "/logbook",
    });
    expect(
      parseDirectoryConfig({
        ...keycloakDirectory,
        KEYCLOAK_CLIENT_ID: "logbook-directory",
        KEYCLOAK_CLIENT_SECRET: "other",
      }),
    ).toMatchObject({ KEYCLOAK_CLIENT_ID: "logbook-directory", KEYCLOAK_CLIENT_SECRET: "other" });
  });

  it("requires a Keycloak realm URL and all three group paths", () => {
    expect(() =>
      parseDirectoryConfig({ ...keycloakDirectory, OIDC_ISSUER: "https://accounts.example.org" }),
    ).toThrow(/realms/);
    for (const name of ["KEYCLOAK_ACCESS_GROUP", "KEYCLOAK_ADMIN_GROUP", "KEYCLOAK_TEAMS_GROUP"]) {
      expect(() => parseDirectoryConfig({ ...keycloakDirectory, [name]: "" }), name).toThrow(name);
    }
    expect(() => parseDirectoryConfig({ ...keycloakDirectory, KEYCLOAK_ACCESS_GROUP: "logbook" })).toThrow(
      /group path/,
    );
    expect(() => parseDirectoryConfig({ ...keycloakDirectory, KEYCLOAK_TEAMS_GROUP: "/org/teams/" })).toThrow(
      /group path/,
    );
    expect(parseDirectoryConfig({ ...keycloakDirectory, KEYCLOAK_TEAMS_GROUP: "/org/teams" })).toMatchObject({
      KEYCLOAK_TEAMS_GROUP: "/org/teams",
    });
  });

  it("rejects an unknown directory", () => {
    expect(() => parseDirectoryConfig({ DIRECTORY: "ldap" })).toThrow(/DIRECTORY/);
  });
});

describe("validateWebConfig", () => {
  it("reports every missing variable at once", () => {
    let error: unknown;
    try {
      validateWebConfig({});
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    for (const name of [
      "DATABASE_URL",
      "LOGBOOK_BASE_URL",
      "BETTER_AUTH_SECRET",
      "OIDC_ISSUER",
      "OIDC_CLIENT_ID",
      "OIDC_CLIENT_SECRET",
      "INITIAL_ADMIN_EMAILS",
    ]) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain("KEYCLOAK");
    expect(message).toContain("- OIDC_ISSUER: is required");
    expect(message).not.toContain("received undefined");
  });

  it("names LOGBOOK_BASE_URL when compose.yaml passes it empty: neither name is in .env", () => {
    const fromCompose = {
      DATABASE_URL: "postgres://u:p@db:5432/logbook",
      ...auth,
      ...manualDirectory,
      LOGBOOK_BASE_URL: "",
    };
    expect(() => validateWebConfig(fromCompose)).toThrow("- LOGBOOK_BASE_URL: is required");
    expect(() => validateWorkerConfig(fromCompose)).toThrow("- LOGBOOK_BASE_URL: is required");
  });

  it("passes with a complete configuration", () => {
    expect(() =>
      validateWebConfig({ DATABASE_URL: "postgres://u:p@db:5432/logbook", ...auth, ...manualDirectory }),
    ).not.toThrow();
    expect(() =>
      validateWebConfig({ DATABASE_URL: "postgres://u:p@db:5432/logbook", ...auth, ...keycloakDirectory }),
    ).not.toThrow();
  });
});

describe("parseNotificationConfig", () => {
  const base = { LOGBOOK_BASE_URL: "https://logbook.example.org/" };

  it("sends for real in production and only logs elsewhere", () => {
    expect(parseNotificationConfig({ ...base, NODE_ENV: "production" }).NOTIFICATION_TRANSPORT).toBe("live");
    expect(parseNotificationConfig({ ...base, NODE_ENV: "development" }).NOTIFICATION_TRANSPORT).toBe(
      "console",
    );
    expect(
      parseNotificationConfig({ ...base, NODE_ENV: "production", NOTIFICATION_TRANSPORT: "console" })
        .NOTIFICATION_TRANSPORT,
    ).toBe("console");
  });
});

describe("parseSealingConfig", () => {
  it("leaves BETTER_AUTH_SECRET optional outside the web process, but long when set", () => {
    expect(parseSealingConfig({}).BETTER_AUTH_SECRET).toBeUndefined();
    expect(parseSealingConfig({ BETTER_AUTH_SECRET: " " }).BETTER_AUTH_SECRET).toBeUndefined();
    expect(() => parseSealingConfig({ BETTER_AUTH_SECRET: "short" })).toThrow(/at least 32/);
  });
});

describe("validateWorkerConfig", () => {
  it("needs the base URL for links in messages, but no BETTER_AUTH_SECRET: an earlier compose.yaml does not pass it", () => {
    expect(() =>
      validateWorkerConfig({ DATABASE_URL: "postgres://u:p@db:5432/logbook", ...manualDirectory }),
    ).toThrow(/LOGBOOK_BASE_URL/);
    expect(() =>
      validateWorkerConfig({
        DATABASE_URL: "postgres://u:p@db:5432/logbook",
        LOGBOOK_BASE_URL: "https://logbook.example.org",
        ...manualDirectory,
      }),
    ).not.toThrow();
  });
});

describe("parseVersionConfig", () => {
  it("has no version in images built from source", () => {
    expect(parseVersionConfig({ APP_VERSION: "" }).APP_VERSION).toBeUndefined();
    expect(parseVersionConfig({ APP_VERSION: "1a2b3c4d5e6f" }).APP_VERSION).toBe("1a2b3c4d5e6f");
  });
});

describe("parseErrorReportingConfig", () => {
  it("is off without a DSN and rejects a DSN that is not a URL", () => {
    expect(parseErrorReportingConfig({ SENTRY_DSN: " " }).SENTRY_DSN).toBeUndefined();
    expect(parseErrorReportingConfig({ SENTRY_DSN: "https://key@o1.ingest.example.org/2" }).SENTRY_DSN).toBe(
      "https://key@o1.ingest.example.org/2",
    );
    expect(() => parseErrorReportingConfig({ SENTRY_DSN: "key@o1" })).toThrow(/SENTRY_DSN/);
    expect(() => validateWorkerConfig({ SENTRY_DSN: "key@o1" })).toThrow(/SENTRY_DSN/);
  });
});
