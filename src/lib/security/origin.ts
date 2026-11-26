import { originOf } from "./csp";

/**
 * True when a state-changing request to a route handler comes from Logbook's
 * own pages: browsers send `Origin` with every POST, and it must be the origin
 * of LOGBOOK_BASE_URL. Server Actions get the same check from Next.js; route
 * handlers do not.
 */
export function isSameOrigin(request: Request, baseUrl: string): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === originOf(baseUrl);
}
