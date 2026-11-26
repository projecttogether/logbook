"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getLogbookAuth } from "@/lib/auth/auth";

/** Starts the login at the identity provider (authorization code flow with PKCE). */
export async function signInAction(): Promise<void> {
  redirect(await getLogbookAuth().signInUrl(await headers()));
}

/**
 * Ends the Logbook session and then the identity provider's session
 * (RP-initiated logout with `id_token_hint`), so the next login asks for
 * credentials again.
 */
export async function signOutAction(): Promise<void> {
  redirect(await getLogbookAuth().signOutUrl(await headers()));
}
