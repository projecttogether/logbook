import type { Database } from "@/lib/db/client";
import type { Directory } from "@/lib/directory/directory";
import { findPersonBySubject } from "@/lib/directory/queries";

/** Error code the login flow uses when someone has no access to Logbook. */
export const NO_ACCESS_ERROR_CODE = "NO_ACCESS";

export interface LoginAccessOptions {
  directory: Directory;
  /** Treat the provider's email addresses as verified (OIDC_TRUST_EMAIL). */
  trustEmail?: boolean;
  now?: Date;
}

/** The OIDC subject and fresh profile of the current login. */
export interface Login {
  subject: string;
  name: string;
  email: string;
  emailVerified: boolean;
}

/**
 * Decides whether a login may get a session. The OIDC `sub` must belong to a
 * person with access. For anyone else the directory decides: the
 * manual directory links an invitation at the first login, the Keycloak
 * directory syncs once and looks again.
 */
export async function admitLogin(
  db: Database,
  login: Login,
  options: LoginAccessOptions,
): Promise<string | undefined> {
  const known = await findPersonBySubject(db, login.subject);
  if (known?.hasAccess) return known.id;
  return options.directory.admitNewLogin(db, {
    ...login,
    known: known !== undefined,
    trustEmail: options.trustEmail ?? false,
    now: options.now ?? new Date(),
  });
}
