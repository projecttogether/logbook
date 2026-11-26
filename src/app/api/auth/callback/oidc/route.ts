import { getLogbookAuth } from "@/lib/auth/auth";

// The only Better Auth endpoint served over HTTP. Its account and session APIs
// act on the shared user record, while Logbook grants access by OIDC subject.
export function GET(request: Request): Promise<Response> {
  return getLogbookAuth().callback(request);
}

// Better Auth also accepts a provider's form_post callback.
export const POST = GET;
