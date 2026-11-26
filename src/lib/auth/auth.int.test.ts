import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectInterceptedDatabase, connectTestDatabase } from "../../../tests/integration/db";
import {
  startFakeOidcProvider,
  type FakeOidcProvider,
  type OidcIdentity,
} from "../../../tests/integration/oidc-provider";
import type { AuthConfig } from "@/lib/config";
import { authAccount, authSession, person } from "@/lib/db/schema";
import { createManualDirectory } from "@/lib/directory/manual";
import { endSessionsForSubjects } from "@/lib/directory/sessions";
import { logger } from "@/lib/logger";
import * as access from "./access";
import { createLogbookAuth, type CreateAuthOptions, type LogbookAuth } from "./auth";

// Better Auth's nextCookies() plugin sets cookies through next/headers, as in
// the sign-in Server Action; the browser sends them with its next request.
const browser = vi.hoisted(() => ({ cookies: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: (name: string, value: string) => browser.cookies.set(name, value) }),
}));

const BASE_URL = "http://localhost:3000";
const testDb = connectTestDatabase();
const { db } = testDb;
let provider: FakeOidcProvider;
let options: CreateAuthOptions;
let auth: LogbookAuth;

beforeAll(async () => {
  provider = await startFakeOidcProvider();
  const config: AuthConfig = {
    LOGBOOK_BASE_URL: BASE_URL,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    OIDC_ISSUER: provider.issuer,
    OIDC_CLIENT_ID: provider.clientId,
    OIDC_CLIENT_SECRET: "test-client-secret",
    OIDC_SCOPES: "openid email profile",
    OIDC_TRUST_EMAIL: false,
  };
  options = { config, directory: createManualDirectory({ initialAdmins: [] }), db };
  auth = createLogbookAuth(options);
});
beforeEach(() => testDb.reset());
afterAll(async () => {
  await provider.close();
  await testDb.close();
});

/** The cookies a response sets, as a request's Cookie header. Cleared cookies are left out. */
function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0]!)
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

/** The headers of a request from a browser with these cookies. */
const withCookie = (cookie: string) => new Headers({ origin: BASE_URL, cookie });

/** Logs in like a browser: the sign-in action, the fake provider approving `identity`, and the callback. */
async function logIn(identity: OidcIdentity) {
  browser.cookies.clear();
  const url = await auth.signInUrl(withCookie(""));
  const authorization = new URL(url);
  expect(authorization.origin).toBe(new URL(provider.issuer).origin);
  const code = provider.approve(url, identity);
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  const sent = [...browser.cookies]
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  const response = await auth.callback(new Request(callback, { headers: { cookie: sent } }));
  return { response, cookie: cookiesOf(response), code };
}

/** The person whose session the cookies carry, while it is active. */
async function personFor(cookie: string) {
  const session = await auth.requestSession(withCookie(cookie));
  return session.status === "active" ? session.person : null;
}

async function addPerson(values: Partial<typeof person.$inferInsert>) {
  const [row] = await db
    .insert(person)
    .values({ displayName: "Someone", hasAccess: true, ...values })
    .returning();
  return row!;
}

/** What a directory sync does when a subject moves to another person: the old sessions end. */
async function moveSubject(from: { id: string }, subject: string) {
  await db.transaction(async (tx) => {
    await tx.update(person).set({ oidcSubject: null }).where(eq(person.id, from.id));
    await tx
      .insert(person)
      .values({ displayName: "New owner", oidcSubject: subject, hasAccess: true, isAdmin: true });
    await endSessionsForSubjects(tx, [subject]);
  });
}

/** Sessions whose database fails the first `statement`, with "diagnostic details" as the error. */
function withFailing(statement: RegExp) {
  let failed = false;
  const failing = connectInterceptedDatabase((sql) => {
    if (failed || !statement.test(sql)) return;
    failed = true;
    throw new Error("diagnostic details");
  });
  return { auth: createLogbookAuth({ ...options, db: failing.db }), close: failing.close };
}

describe("login with the OIDC provider", () => {
  it("logs Better Auth diagnostics without their details", async () => {
    const log = vi.spyOn(logger, "error");
    try {
      const response = await auth.callback(
        new Request(`${BASE_URL}/api/auth/callback/oidc?code=forged&state=forged`),
      );

      expect(response.headers.get("location")).toBe(`${BASE_URL}/login?error=state_mismatch`);
      expect(log.mock.calls).toEqual([["Better Auth reported an event"]]);
    } finally {
      log.mockRestore();
    }
  });

  it("returns a generic error when sign-in cannot start", async () => {
    const unavailable = createLogbookAuth({
      ...options,
      config: { ...options.config, OIDC_ISSUER: `${provider.issuer}/missing` },
    });
    const log = vi.spyOn(logger, "error");
    try {
      expect(await unavailable.signInUrl(withCookie(""))).toBe("/login?error=OIDC_SIGN_IN_FAILED");
      expect(log).toHaveBeenLastCalledWith("Could not start OIDC sign-in");
      // Better Auth's own reports of the failure arrive without their details.
      const reports = log.mock.calls.slice(0, -1);
      expect(reports).toEqual(reports.map(() => ["Better Auth reported an event"]));
    } finally {
      log.mockRestore();
    }
  });

  it("handles an unexpected callback failure without logging the exception", async () => {
    const admission = vi.spyOn(access, "admitLogin").mockRejectedValueOnce(new Error("diagnostic details"));
    const frameworkLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const appLog = vi.spyOn(logger, "error");
    try {
      const { response, cookie } = await logIn({ sub: "sub-ada", email: "ada@example.org" });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login?error=OIDC_CALLBACK_FAILED");
      expect(cookie).not.toContain("session_token");
      expect(frameworkLog).not.toHaveBeenCalled();
      expect(appLog.mock.calls).toEqual([["OIDC callback failed"]]);
    } finally {
      admission.mockRestore();
      frameworkLog.mockRestore();
      appLog.mockRestore();
    }
  });

  it("keeps each session with the person of the `sub` it logged in with", async () => {
    const ada = await addPerson({ oidcSubject: "sub-ada", displayName: "Ada" });
    const bea = await addPerson({ oidcSubject: "sub-bea", displayName: "Bea" });

    // Two subjects with the same verified email: Better Auth links both to one user.
    const first = await logIn({ sub: "sub-ada", email: "shared@example.org" });
    const second = await logIn({ sub: "sub-bea", email: "shared@example.org" });

    expect((await personFor(first.cookie))?.id).toBe(ada.id);
    expect((await personFor(second.cookie))?.id).toBe(bea.id);
    const sessions = await db.select().from(authSession).orderBy(authSession.createdAt);
    expect(sessions.map((s) => s.oidcSubject)).toEqual(["sub-ada", "sub-bea"]);
    expect(sessions.map((s) => s.oidcPersonId)).toEqual([ada.id, bea.id]);
    expect(sessions[0]!.userId).toBe(sessions[1]!.userId);

    // Ending the sessions of one subject leaves the other's.
    await endSessionsForSubjects(db, ["sub-bea"]);
    expect((await personFor(first.cookie))?.id).toBe(ada.id);
    expect(await personFor(second.cookie)).toBeNull();
  });

  it("rejects an in-flight login when its admitted person loses the subject", async () => {
    const subject = "sub-ada";
    const ada = await addPerson({ oidcSubject: subject });
    const { cookie } = await logIn({ sub: subject, email: "ada@example.org" });

    const admitLogin = access.admitLogin;
    const admission = vi.spyOn(access, "admitLogin").mockImplementationOnce(async (...args) => {
      const personId = await admitLogin(...args);
      await moveSubject(ada, subject);
      return personId;
    });
    try {
      const login = await logIn({ sub: subject, email: "ada@example.org" });
      expect(login.response.headers.get("location")).toContain("/login?error=NO_ACCESS");
      expect(login.cookie).not.toContain("session_token");
    } finally {
      admission.mockRestore();
    }
    expect(await personFor(cookie)).toBeNull();
    expect(await db.select().from(authSession)).toHaveLength(0);
  });

  it("checks the live session row when a sync ends it while the request reads it", async () => {
    const subject = "sub-ada";
    const ada = await addPerson({ oidcSubject: subject });
    const { cookie } = await logIn({ sub: subject, email: "ada@example.org" });

    // The sync runs after the cookie lookup and before the person lookup.
    let moved = false;
    const racing = connectInterceptedDatabase(async (sql) => {
      if (!moved && sql.includes('inner join "person"')) {
        moved = true;
        await moveSubject(ada, subject);
      }
    });
    try {
      const session = await createLogbookAuth({ ...options, db: racing.db }).requestSession(
        withCookie(cookie),
      );
      expect(moved).toBe(true);
      expect(session).toEqual({ status: "ended" });
    } finally {
      await racing.close();
    }
    expect(await db.select().from(authSession)).toHaveLength(0);
  });

  it("ends a session whose person lost access when it is read", async () => {
    const ada = await addPerson({ oidcSubject: "sub-ada" });
    const { cookie } = await logIn({ sub: "sub-ada", email: "ada@example.org" });
    // Taken away without ending the session, as in a race with the directory.
    await db.update(person).set({ hasAccess: false }).where(eq(person.id, ada.id));

    expect(await auth.requestSession(withCookie(cookie))).toEqual({ status: "ended" });
    expect(await db.select().from(authSession)).toHaveLength(0);
    expect(await auth.requestSession(withCookie(cookie))).toEqual({ status: "none" });
  });

  it("keeps session lookup error details out of protected requests", async () => {
    await addPerson({ oidcSubject: "sub-ada" });
    const { cookie } = await logIn({ sub: "sub-ada", email: "ada@example.org" });
    const failing = withFailing(/^select\b[\s\S]*\bfrom "auth_session"/);
    try {
      const result = failing.auth.requestSession(withCookie(cookie));
      await expect(result).rejects.toThrow("Could not read the Logbook session");
      await expect(result).rejects.not.toHaveProperty("cause");
    } finally {
      await failing.close();
    }
  });

  it("requires a fresh sign-in for a legacy session without a person binding", async () => {
    await addPerson({ oidcSubject: "sub-ada" });
    const { cookie } = await logIn({ sub: "sub-ada", email: "ada@example.org" });
    await db.update(authSession).set({ oidcPersonId: null });

    expect(await auth.requestSession(withCookie(cookie))).toEqual({ status: "none" });
    const fresh = await logIn({ sub: "sub-ada", email: "ada@example.org" });
    expect(await personFor(fresh.cookie)).toMatchObject({ oidcSubject: "sub-ada" });
  });

  it("links an invitation at the first login", async () => {
    const invited = await addPerson({ workEmail: "erika@example.org" });
    const { cookie } = await logIn({ sub: "sub-erika", email: "erika@example.org", name: "Erika Example" });

    const current = await personFor(cookie);
    expect(current).toMatchObject({ id: invited.id, oidcSubject: "sub-erika", displayName: "Erika Example" });
  });

  it("checks the current OIDC email before linking an invitation", async () => {
    await logIn({ sub: "sub-ada", email: "shared@example.org" });
    const invited = await addPerson({ workEmail: "shared@example.org" });

    const login = await logIn({ sub: "sub-ada", email: "ada@example.org" });
    expect(login.cookie).not.toContain("session_token");
    const [row] = await db.select().from(person).where(eq(person.id, invited.id));
    expect(row?.oidcSubject).toBeNull();
  });

  it("stores the provider's access and refresh tokens encrypted", async () => {
    await addPerson({ oidcSubject: "sub-ada" });
    const { code } = await logIn({ sub: "sub-ada", email: "ada@example.org" });
    const issued = provider.tokensFor(code)!;

    const [account] = await db.select().from(authAccount).where(eq(authAccount.accountId, "sub-ada"));
    expect(account?.accessToken).toBeTruthy();
    expect(account?.accessToken).not.toContain(issued.accessToken);
    expect(account?.refreshToken).toBeTruthy();
    expect(account?.refreshToken).not.toContain(issued.refreshToken);
    expect(account?.idToken).toBe(issued.idToken);
  });

  it("logs out with the ID token for the session's own OIDC subject", async () => {
    await addPerson({ oidcSubject: "sub-ada" });
    await addPerson({ oidcSubject: "sub-bea" });
    const ada = await logIn({ sub: "sub-ada", email: "shared@example.org" });
    const bea = await logIn({ sub: "sub-bea", email: "shared@example.org" });

    const logoutUrl = new URL(await auth.signOutUrl(withCookie(ada.cookie)));
    expect(logoutUrl.origin).toBe(new URL(provider.issuer).origin);
    expect(logoutUrl.searchParams.get("client_id")).toBe(provider.clientId);
    expect(logoutUrl.searchParams.get("post_logout_redirect_uri")).toBe(`${BASE_URL}/`);
    expect(logoutUrl.searchParams.get("id_token_hint")).toBe(provider.tokensFor(ada.code)?.idToken);
    expect(await personFor(ada.cookie)).toBeNull();
    expect(await personFor(bea.cookie)).toMatchObject({ oidcSubject: "sub-bea" });
  });

  it("ends the local session and reaches provider logout when the session lookup fails", async () => {
    await addPerson({ oidcSubject: "sub-ada" });
    const { cookie } = await logIn({ sub: "sub-ada", email: "ada@example.org" });
    const failing = withFailing(/^select\b[\s\S]*\bfrom "auth_session"/);

    try {
      const logoutUrl = new URL(await failing.auth.signOutUrl(withCookie(cookie)));
      expect(logoutUrl.origin).toBe(new URL(provider.issuer).origin);
      expect(logoutUrl.searchParams.has("id_token_hint")).toBe(false);
      expect(await db.select().from(authSession)).toHaveLength(0);
    } finally {
      await failing.close();
    }
  });

  it("returns to login after local sign-out when the provider token cannot be read", async () => {
    await addPerson({ oidcSubject: "sub-ada" });
    const { cookie } = await logIn({ sub: "sub-ada", email: "ada@example.org" });
    // Logbook's lookup of the ID token, by the session's subject and person.
    const failing = withFailing(/\bfrom "auth_account" inner join "person"/);

    try {
      expect(await failing.auth.signOutUrl(withCookie(cookie))).toBe("/login");
      expect(await personFor(cookie)).toBeNull();
    } finally {
      await failing.close();
    }
  });

  it("gives no session to someone without access", async () => {
    await addPerson({ oidcSubject: "sub-lea", hasAccess: false });
    const { response, cookie } = await logIn({ sub: "sub-lea", email: "lea@example.org" });

    expect(response.headers.get("location")).toContain("/login?error=");
    expect(cookie).not.toContain("session_token");
    expect(await db.select().from(authSession)).toHaveLength(0);
    const [lea] = await db.select().from(person).where(eq(person.oidcSubject, "sub-lea"));
    expect(lea?.hasAccess).toBe(false);
  });
});
