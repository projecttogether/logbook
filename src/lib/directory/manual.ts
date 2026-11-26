import { and, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import type { Database } from "@/lib/db/client";
import { person } from "@/lib/db/schema";
import type { Directory, NewLogin } from "./directory";
import { findPersonBySubject } from "./queries";

/** Serializes first logins in the manual directory, so an invitation is linked once. */
const LINK_LOCK_KEY = 7_261_002;

/**
 * The manual directory. At the first login, an invitation whose email
 * matches the user's verified email is linked to the `sub`. While nobody is
 * an admin yet, a verified email in `initialAdmins` (INITIAL_ADMIN_EMAILS)
 * becomes the first admin. Afterwards the person is matched by `sub` only, so
 * someone known without access stays out.
 */
export function createManualDirectory({ initialAdmins }: { initialAdmins: string[] }): Directory {
  return {
    kind: "manual",
    editable: true,
    sync: null,
    async admitNewLogin(db, login) {
      if (login.known) return undefined;
      return linkFirstLogin(db, login, initialAdmins);
    },
  };
}

async function linkFirstLogin(
  db: Database,
  login: NewLogin,
  initialAdmins: string[],
): Promise<string | undefined> {
  const { subject, trustEmail, now } = login;
  // Only the email from this OIDC login may claim an invitation.
  const email = login.email.trim().toLowerCase();
  if (!email || !(login.emailVerified || trustEmail)) return undefined;
  const name = login.name.trim();

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LINK_LOCK_KEY})`);
    // Another login of the same user may have linked it meanwhile.
    const linked = await findPersonBySubject(tx, subject);
    if (linked) return linked.hasAccess ? linked.id : undefined;

    const [invited] = await tx
      .select()
      .from(person)
      .where(
        and(
          sql`lower(${person.workEmail}) = ${email}`,
          isNull(person.oidcSubject),
          eq(person.hasAccess, true),
        ),
      )
      .orderBy(person.createdAt)
      .limit(1);
    if (invited) {
      await tx
        .update(person)
        .set({ oidcSubject: subject, displayName: name || invited.displayName, updatedAt: now })
        .where(eq(person.id, invited.id));
      await recordAudit(tx, { actorId: invited.id, action: "person.linked", payload: { email } });
      return invited.id;
    }

    if (!initialAdmins.includes(email)) return undefined;
    const [admin] = await tx
      .select({ id: person.id })
      .from(person)
      .where(and(eq(person.isAdmin, true), eq(person.hasAccess, true)))
      .limit(1);
    if (admin) return undefined;
    const [created] = await tx
      .insert(person)
      .values({
        oidcSubject: subject,
        displayName: name || email,
        workEmail: email,
        hasAccess: true,
        isAdmin: true,
        accessChangedAt: now,
      })
      .returning({ id: person.id });
    await recordAudit(tx, { actorId: created!.id, action: "person.first_admin", payload: { email } });
    return created!.id;
  });
}
