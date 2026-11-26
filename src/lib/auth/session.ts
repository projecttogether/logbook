import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/lib/db/client";
import type { PersonRow } from "@/lib/directory/queries";
import { createDateFormatter, type DateFormatter } from "@/lib/format";
import { recordActivity } from "@/lib/measures/activity";
import { displayPreferences } from "@/lib/preferences";
import { getLogbookAuth, type RequestSession } from "./auth";

export interface CurrentUser {
  userId: string;
  person: PersonRow;
}

/**
 * The session behind this request, read once per request. Reading ends a
 * session whose person lost access or the OIDC subject (`requestSession`).
 */
const loadRequestSession = cache(async (): Promise<RequestSession> =>
  getLogbookAuth().requestSession(await headers()),
);

/** The person behind this request if they have access, without redirecting (for route handlers). */
export async function getCurrentPerson(): Promise<PersonRow | null> {
  const session = await loadRequestSession();
  return session.status === "active" ? session.person : null;
}

/** The admin behind this request, without redirecting (for admin-only route handlers, which answer 404 otherwise). */
export async function getCurrentAdmin(): Promise<PersonRow | null> {
  const person = await getCurrentPerson();
  return person?.isAdmin ? person : null;
}

/**
 * Whether this request has a session: `active`, `ended` (its person lost
 * access, and reading it ended it), or `none`.
 */
export async function sessionStatus(): Promise<RequestSession["status"]> {
  return (await loadRequestSession()).status;
}

/**
 * How dates and times are shown to the person behind this request: their own
 * time zone and date format, or the defaults.
 */
export const getFormatter = cache(async (): Promise<DateFormatter> => {
  const session = await loadRequestSession();
  return createDateFormatter(displayPreferences(session.status === "active" ? session.person : undefined));
});

/**
 * Every page, Server Action, and route handler calls this (or
 * `requireAdmin`). It checks the access flag in the database on each request
 * and notes the month as active for the person.
 */
export async function requireUser(): Promise<CurrentUser> {
  const session = await loadRequestSession();
  if (session.status === "none") redirect("/login");
  if (session.status === "ended") redirect("/no-access");
  await recordActivity(getDb(), session.person.id);
  return { userId: session.userId, person: session.person };
}

/** Like `requireUser`, and the person must be a Logbook admin. */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (!user.person.isAdmin) notFound();
  return user;
}
