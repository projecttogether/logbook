import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTestDatabase } from "../../../tests/integration/db";
import { directoryPerson, snapshot } from "../../../tests/fixtures/directory";
import { auditEvent, person } from "@/lib/db/schema";
import {
  createKeycloakDirectory,
  LOGIN_SYNC_MIN_INTERVAL_MS,
  type DirectorySync,
} from "@/lib/directory/directory";
import { createManualDirectory } from "@/lib/directory/manual";
import { syncDirectory } from "@/lib/directory/sync";
import type { DirectoryAdapter } from "@/lib/directory/types";
import { admitLogin, type Login } from "./access";

const testDb = connectTestDatabase();
const { db, pool } = testDb;

function syncWith(...ids: string[]) {
  const adapter: DirectoryAdapter = {
    name: "test",
    fetchSnapshot: async () => snapshot(ids.map((id) => directoryPerson({ externalId: id }))),
  };
  return () => syncDirectory({ pool, adapter, trigger: "login" });
}

/** The Keycloak directory, whose login sync is `run`. */
function keycloak(run: DirectorySync["run"] = vi.fn()) {
  return createKeycloakDirectory({ accessGroup: "/logbook", adminGroup: "/logbook-admins", run });
}

/** The profile asserted by the OIDC provider for this login. */
function oidcLogin(subject: string, profile: Partial<Omit<Login, "subject">> = {}): Login {
  return { subject, name: subject, email: `${subject}@example.test`, emailVerified: true, ...profile };
}

beforeEach(() => testDb.reset());
afterAll(() => testDb.close());

describe("admitLogin with the Keycloak directory", () => {
  it("allows a person with access without syncing", async () => {
    await syncWith("p1")();
    const login = oidcLogin("sub-p1");
    const run = vi.fn();
    await expect(admitLogin(db, login, { directory: keycloak(run) })).resolves.toEqual(expect.any(String));
    expect(run).not.toHaveBeenCalled();
  });

  it("syncs once when the person is unknown, then allows a newly added member", async () => {
    await syncWith("p1")();
    const login = oidcLogin("sub-p2");
    const run = vi.fn(syncWith("p1", "p2"));
    await expect(admitLogin(db, login, { directory: keycloak(run) })).resolves.toEqual(expect.any(String));
    expect(run).toHaveBeenCalledExactlyOnceWith("login", LOGIN_SYNC_MIN_INTERVAL_MS);
  });

  it("denies someone outside the access group, even after a sync", async () => {
    await syncWith("p1")();
    const login = oidcLogin("sub-outsider");
    const run = vi.fn(syncWith("p1"));
    await expect(admitLogin(db, login, { directory: keycloak(run) })).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("denies a person who lost access", async () => {
    await syncWith("p1", "p2")();
    await syncWith("p1")();
    const login = oidcLogin("sub-p2");
    await expect(admitLogin(db, login, { directory: keycloak(syncWith("p1")) })).resolves.toBeUndefined();
  });
});

describe("admitLogin with the manual directory", () => {
  const options = (initialAdmins: string[] = []) => ({ directory: createManualDirectory({ initialAdmins }) });

  async function invite(email: string, values: Partial<typeof person.$inferInsert> = {}) {
    const [row] = await db
      .insert(person)
      .values({ displayName: "Invited Name", workEmail: email, hasAccess: true, ...values })
      .returning();
    return row!;
  }

  it("links an invitation to the first login with the same verified email", async () => {
    const invited = await invite("Erika@Example.org");
    const login = oidcLogin("sub-erika", { email: "erika@example.org", name: "Erika Example" });
    await expect(admitLogin(db, login, options())).resolves.toBe(invited.id);

    const [linked] = await db.select().from(person).where(eq(person.id, invited.id));
    expect(linked).toMatchObject({ oidcSubject: "sub-erika", displayName: "Erika Example", hasAccess: true });
    const events = await db.select().from(auditEvent);
    expect(events.map((e) => e.action)).toEqual(["person.linked"]);

    // Later logins match the subject, not the email.
    await expect(admitLogin(db, login, options())).resolves.toBe(invited.id);
    expect(await db.select().from(auditEvent)).toHaveLength(1);
  });

  it("does not link an unverified email", async () => {
    await invite("erika@example.org");
    const login = oidcLogin("sub-erika", { email: "erika@example.org", emailVerified: false });
    await expect(admitLogin(db, login, options())).resolves.toBeUndefined();
    const [row] = await db.select().from(person);
    expect(row?.oidcSubject).toBeNull();
  });

  it("links an unverified email when the provider's addresses are trusted (OIDC_TRUST_EMAIL)", async () => {
    const invited = await invite("erika@example.org");
    const login = oidcLogin("sub-erika", { email: "erika@example.org", emailVerified: false });
    await expect(admitLogin(db, login, { ...options(), trustEmail: true })).resolves.toBe(invited.id);
    const [linked] = await db.select().from(person).where(eq(person.id, invited.id));
    expect(linked?.oidcSubject).toBe("sub-erika");
  });

  it("denies someone who was not invited, and an invitation whose access was taken away", async () => {
    await invite("gone@example.org", { hasAccess: false });
    await expect(
      admitLogin(db, oidcLogin("sub-gone", { email: "gone@example.org" }), options()),
    ).resolves.toBeUndefined();
    await expect(
      admitLogin(db, oidcLogin("sub-stranger", { email: "stranger@example.org" }), options()),
    ).resolves.toBeUndefined();
  });

  it("denies a linked person whose access was taken away", async () => {
    await invite("erika@example.org", { oidcSubject: "sub-erika", hasAccess: false });
    const login = oidcLogin("sub-erika", { email: "erika@example.org" });
    await expect(admitLogin(db, login, options())).resolves.toBeUndefined();
  });

  it("makes the first admin from INITIAL_ADMIN_EMAILS while there is no admin", async () => {
    const login = oidcLogin("sub-owner", { email: "Owner@Example.org", name: "Olivia Owner" });
    await expect(admitLogin(db, login, options(["owner@example.org"]))).resolves.toEqual(expect.any(String));
    const [owner] = await db.select().from(person);
    expect(owner).toMatchObject({
      oidcSubject: "sub-owner",
      displayName: "Olivia Owner",
      workEmail: "owner@example.org",
      isAdmin: true,
      hasAccess: true,
    });
    expect((await db.select().from(auditEvent)).map((e) => e.action)).toEqual(["person.first_admin"]);

    // Once there is an admin, the list grants nothing more.
    const second = oidcLogin("sub-second", { email: "second@example.org" });
    await expect(
      admitLogin(db, second, options(["owner@example.org", "second@example.org"])),
    ).resolves.toBeUndefined();
  });

  it("does not make an unverified email the first admin", async () => {
    const login = oidcLogin("sub-owner", { email: "owner@example.org", emailVerified: false });
    await expect(admitLogin(db, login, options(["owner@example.org"]))).resolves.toBeUndefined();
    expect(await db.select().from(person)).toHaveLength(0);
  });
});
