import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { and, DrizzleQueryError, eq } from "drizzle-orm";
import { DatabaseError } from "pg";
import { getAuthConfig, type AuthConfig } from "@/lib/config";
import { getDb, type Database } from "@/lib/db/client";
import { authAccount, authSession, authUser, authVerification, person } from "@/lib/db/schema";
import { getDirectory, type Directory } from "@/lib/directory/directory";
import type { PersonRow } from "@/lib/directory/queries";
import { OIDC_PROVIDER_ID } from "@/lib/directory/sessions";
import { logger } from "@/lib/logger";
import { admitLogin, NO_ACCESS_ERROR_CODE, type Login } from "./access";
import { discoveryUrl } from "./discovery-url";
import { getOidcEndpoints } from "./oidc-discovery";

/*
 * Logbook's sessions: sign-in at the OIDC provider, the provider's callback,
 * the person behind a request, and sign-out. Better Auth does the protocol
 * work behind this module; nothing else calls it. Its account and session
 * APIs act on the shared Better Auth user, while Logbook grants access by OIDC
 * subject: each session belongs to the person admitted for the `sub` it
 * logged in with, and counts only while that person still owns the `sub`.
 */

/** The session behind a request. */
export type RequestSession =
  /** No session, or one from before sessions were bound to a person: sign in again. */
  | { status: "none" }
  /**
   * The session's person lost access or the OIDC subject after login (the
   * directory normally ends these sessions first). Reading it ended it.
   */
  | { status: "ended" }
  | { status: "active"; userId: string; person: PersonRow };

export interface LogbookAuth {
  /**
   * Where to send the browser to sign in: the provider's authorization URL,
   * or `/login?error=OIDC_SIGN_IN_FAILED` when sign-in cannot start. Logs no
   * details of the failure.
   */
  signInUrl(headers: Headers): Promise<string>;
  /**
   * Answers the provider's callback (GET, or POST for form_post). An
   * admitted login gets a session cookie; Logbook's own denials redirect to
   * `/login?error=...`. Never throws: an unexpected failure redirects to
   * `/login?error=OIDC_CALLBACK_FAILED` and is logged without details.
   */
  callback(request: Request): Promise<Response>;
  /**
   * The session of the request's cookies and the person bound to it. Reading
   * can end the session: when its person lost access or the OIDC subject, the
   * session is deleted and the status is `ended`. A failed lookup throws
   * "Could not read the Logbook session", without the cause.
   */
  requestSession(headers: Headers): Promise<RequestSession>;
  /**
   * Ends the request's session, then returns where to send the browser: the
   * provider's logout (RP-initiated, with the ID token of the session's own
   * `sub` as `id_token_hint` when it can be read), or `/login` without a
   * logout endpoint or when the token lookup fails. The provider logout
   * still happens when the session cannot be read first; a failed local
   * sign-out throws.
   */
  signOutUrl(headers: Headers): Promise<string>;
}

export interface CreateAuthOptions {
  config: AuthConfig;
  directory: Directory;
  db: Database;
}

function noAccessError() {
  return new APIError("FORBIDDEN", {
    code: NO_ACCESS_ERROR_CODE,
    message: "You do not have access to Logbook.",
  });
}

/**
 * Better Auth with one OpenID Connect provider (authorization code flow with
 * PKCE) as the only login. Endpoints, including logout, come from the
 * provider's discovery document. Sessions live in PostgreSQL and are read on
 * every request, so ending a session takes effect immediately.
 */
function createAuth({ config, directory, db }: CreateAuthOptions) {
  /**
   * The OIDC `sub` each login verified, by Better Auth endpoint context. The
   * OAuth callback writes the account row of that `sub` and then creates the
   * session, both in one request. The user ID alone does not say who logged in:
   * Better Auth links a new `sub` whose verified email matches an existing user
   * to that user.
   */
  const loginAccounts = new WeakMap<object, { userId: string; subject: string }>();
  const loginProfiles = new WeakMap<object, Omit<Login, "subject">>();

  function rememberLoginAccount(
    context: object | null,
    account: { providerId: string; accountId: string; userId: string } | null,
  ) {
    if (!context || account?.providerId !== OIDC_PROVIDER_ID) return;
    loginAccounts.set(context, { userId: account.userId, subject: account.accountId });
  }

  function loginSubjectOf(context: object | null, userId: string): string | undefined {
    const login = context ? loginAccounts.get(context) : undefined;
    return login?.userId === userId ? login.subject : undefined;
  }

  return betterAuth({
    appName: "Logbook",
    baseURL: config.LOGBOOK_BASE_URL,
    basePath: "/api/auth",
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.LOGBOOK_BASE_URL],
    logger: {
      log(level) {
        // Better Auth diagnostics can contain provider responses or database
        // errors with session tokens and other bound values.
        logger[level]("Better Auth reported an event");
      },
    },
    database: (options: BetterAuthOptions) => {
      const adapter = drizzleAdapter(db, {
        provider: "pg",
        schema: {
          user: authUser,
          session: authSession,
          account: authAccount,
          verification: authVerification,
        },
      })(options);
      const create: typeof adapter.create = async (input) => {
        try {
          return await adapter.create(input);
        } catch (error) {
          // A subject can move after admission. Report the expected denial
          // before Better Auth sees a query error with session parameters.
          if (
            error instanceof DrizzleQueryError &&
            error.cause instanceof DatabaseError &&
            error.cause.constraint === "logbook_session_person_binding"
          ) {
            throw noAccessError();
          }
          throw error;
        }
      };
      return { ...adapter, create };
    },
    emailAndPassword: { enabled: false },
    user: {
      validateUserInfo({ user, source }, context) {
        // A stored Better Auth profile can outlive an email change or belong
        // to multiple subjects. Keep the provider's claims for this login.
        if (source.oauth?.providerId === OIDC_PROVIDER_ID && typeof user.email === "string") {
          loginProfiles.set(context, {
            email: user.email,
            emailVerified: user.emailVerified === true,
            name: user.name ?? "",
          });
        }
      },
    },
    session: {
      // No cookie cache: every request checks the session in the database.
      cookieCache: { enabled: false },
      additionalFields: {
        // Set by the session hook below, never from the request.
        oidcSubject: { type: "string", required: true, input: false },
        oidcPersonId: { type: "string", required: false, input: false },
      },
    },
    // Logbook never uses the provider's access and refresh tokens, but
    // Better Auth stores them: keep them encrypted (with BETTER_AUTH_SECRET).
    // The ID token stays readable; logout sends it as `id_token_hint`.
    account: { encryptOAuthTokens: true },
    advanced: {
      cookiePrefix: "logbook",
      useSecureCookies: config.LOGBOOK_BASE_URL.startsWith("https://"),
    },
    // Let the callback handle unexpected errors before the HTTP router can
    // write the exception directly to the console.
    onAPIError: { errorURL: `${config.LOGBOOK_BASE_URL}/login`, throw: true },
    databaseHooks: {
      account: {
        create: { after: async (account, context) => rememberLoginAccount(context, account) },
        update: { after: async (account, context) => rememberLoginAccount(context, account) },
      },
      session: {
        create: {
          // The access rule runs before a session exists, so people without
          // access never get one. The session keeps the `sub` it logged in
          // with; without one, there is no session.
          before: async (session, context) => {
            const subject = loginSubjectOf(context, session.userId);
            const profile = context ? loginProfiles.get(context) : undefined;
            const personId =
              subject !== undefined && profile !== undefined
                ? await admitLogin(
                    db,
                    { ...profile, subject },
                    {
                      directory,
                      trustEmail: config.OIDC_TRUST_EMAIL,
                    },
                  )
                : undefined;
            if (subject === undefined || !personId) {
              logger.info({ userId: session.userId }, "login denied: no access");
              throw noAccessError();
            }
            return { data: { ...session, oidcSubject: subject, oidcPersonId: personId } };
          },
        },
      },
    },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: OIDC_PROVIDER_ID,
            discoveryUrl: discoveryUrl(config.OIDC_ISSUER),
            clientId: config.OIDC_CLIENT_ID,
            clientSecret: config.OIDC_CLIENT_SECRET,
            scopes: config.OIDC_SCOPES.split(/[\s,]+/).filter(Boolean),
            pkce: true,
            requireIdTokenVerification: true,
            // Logbook builds the logout URL from the session's OIDC subject.
            disableProviderLogout: true,
          },
        ],
      }),
      // Must be last: applies cookies set by auth.api calls in Server Actions.
      nextCookies(),
    ],
  });
}

/** Checks the live session and its person binding in one database snapshot. */
async function findPersonForSession(db: Database, sessionId: string): Promise<PersonRow | undefined> {
  const [row] = await db
    .select({ person })
    .from(authSession)
    .innerJoin(
      person,
      and(eq(person.id, authSession.oidcPersonId), eq(person.oidcSubject, authSession.oidcSubject)),
    )
    .where(eq(authSession.id, sessionId));
  return row?.person;
}

/** Logbook's sessions for one configuration, provider, directory, and database. */
export function createLogbookAuth(options: CreateAuthOptions): LogbookAuth {
  const { config, db } = options;
  const auth = createAuth(options);
  return {
    async signInUrl(headers) {
      try {
        const result = await auth.api.signInSocial({
          body: { provider: OIDC_PROVIDER_ID, callbackURL: "/", errorCallbackURL: "/login" },
          headers,
        });
        if (!result.url) throw new Error("Better Auth returned no authorization URL");
        return result.url;
      } catch {
        logger.error("Could not start OIDC sign-in");
        return "/login?error=OIDC_SIGN_IN_FAILED";
      }
    },

    async callback(request) {
      try {
        return await auth.handler(request);
      } catch {
        logger.error("OIDC callback failed");
        return new Response(null, {
          status: 303,
          headers: { Location: "/login?error=OIDC_CALLBACK_FAILED", "Cache-Control": "no-store" },
        });
      }
    },

    async requestSession(headers) {
      const session = await auth.api.getSession({ headers }).catch(() => {
        // Better Auth logs at the auth boundary. Keep the request failure without
        // forwarding a database error cause to Next.js or error reporting.
        throw new Error("Could not read the Logbook session");
      });
      if (!session?.session.oidcPersonId) return { status: "none" };
      // The person bound at sign-in, while it still owns the OIDC subject.
      const found = await findPersonForSession(db, session.session.id);
      if (!found?.hasAccess) {
        // Access ended after login (the sync normally ends these sessions first).
        await db.delete(authSession).where(eq(authSession.id, session.session.id));
        return { status: "ended" };
      }
      return { status: "active", userId: session.user.id, person: found };
    },

    async signOutUrl(headers) {
      const session = await auth.api
        .getSession({
          headers,
          query: { disableRefresh: true },
        })
        .catch(() => {
          logger.warn("Could not read the session for provider logout");
          return null;
        });
      await auth.api.signOut({ headers });

      const endSession = (await getOidcEndpoints(config.OIDC_ISSUER))?.endSessionEndpoint;
      if (!endSession) return "/login";
      const logoutUrl = new URL(endSession);
      logoutUrl.searchParams.set("client_id", config.OIDC_CLIENT_ID);
      logoutUrl.searchParams.set("post_logout_redirect_uri", `${config.LOGBOOK_BASE_URL}/`);
      if (session?.session.oidcPersonId) {
        // The shared Better Auth user may have several OIDC subjects. Use only
        // the token for the subject that started this Logbook session.
        try {
          const [account] = await db
            .select({ idToken: authAccount.idToken })
            .from(authAccount)
            .innerJoin(person, eq(person.oidcSubject, authAccount.accountId))
            .where(
              and(
                eq(authAccount.providerId, OIDC_PROVIDER_ID),
                eq(authAccount.accountId, session.session.oidcSubject),
                eq(person.id, session.session.oidcPersonId),
              ),
            );
          if (account?.idToken) logoutUrl.searchParams.set("id_token_hint", account.idToken);
        } catch {
          logger.warn("Could not read the provider logout token");
          return "/login";
        }
      }
      return logoutUrl.toString();
    },
  };
}

// Not `logbookAuth`: a development server may still hold the Better Auth
// instance that earlier versions kept under that key.
const globalForAuth = globalThis as unknown as { logbookSessions?: LogbookAuth };

/** This process's sessions, for the configured provider and directory. */
export function getLogbookAuth(): LogbookAuth {
  globalForAuth.logbookSessions ??= createLogbookAuth({
    config: getAuthConfig(),
    directory: getDirectory(),
    db: getDb(),
  });
  return globalForAuth.logbookSessions;
}
