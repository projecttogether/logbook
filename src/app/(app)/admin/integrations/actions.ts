"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { INTEGRATION_NAMES, type IntegrationViews, type TestResult } from "@/lib/integrations/schemas";
import { IntegrationError, saveIntegration, testEmail, testSlack } from "@/lib/integrations/service";
import { consumeRateLimit, RateLimitError, WRITE_LIMIT } from "@/lib/rate-limit";

/*
 * Admin › Integrations. The page sends the same JSON body that
 * `cli settings apply` reads; both call saveIntegration. Values a page binds
 * arrive as the client sends them, so the setting's name is checked too.
 */

export type SaveIntegrationResult =
  | { ok: true; message: string; view: IntegrationViews[keyof IntegrationViews] }
  | { ok: false; message: string; fieldErrors: Record<string, string> };

const OUT_OF_DATE = "This form is out of date. Reload the page and try again.";
const nameSchema = z.enum(INTEGRATION_NAMES);

export async function saveIntegrationAction(name: unknown, body: unknown): Promise<SaveIntegrationResult> {
  const user = await requireAdmin();
  const setting = nameSchema.safeParse(name);
  if (!setting.success) return { ok: false, message: OUT_OF_DATE, fieldErrors: {} };
  try {
    await consumeRateLimit(getDb(), `write:${user.person.id}`, WRITE_LIMIT);
    const { message, view } = await saveIntegration(getDb(), setting.data, body, {
      personId: user.person.id,
    });
    revalidatePath("/admin/integrations");
    revalidatePath("/admin");
    return { ok: true, message, view };
  } catch (error) {
    if (error instanceof IntegrationError)
      return { ok: false, message: error.message, fieldErrors: error.fieldErrors };
    if (error instanceof RateLimitError) return { ok: false, message: error.message, fieldErrors: {} };
    throw error;
  }
}

export type TestIntegrationResult = TestResult & { fieldErrors?: Record<string, string> };

/** The test buttons: Slack checks the token and posts to the channel; email sends to an address. */
export async function testIntegrationAction(name: unknown, input: unknown): Promise<TestIntegrationResult> {
  const user = await requireAdmin();
  const setting = z.enum(["slack", "email"]).safeParse(name);
  if (!setting.success) return { ok: false, message: OUT_OF_DATE };
  try {
    // A test sends a message: it counts like a write.
    await consumeRateLimit(getDb(), `write:${user.person.id}`, WRITE_LIMIT);
    return setting.data === "slack" ? await testSlack(getDb()) : await testEmail(getDb(), input);
  } catch (error) {
    if (error instanceof IntegrationError)
      return { ok: false, message: error.message, fieldErrors: error.fieldErrors };
    if (error instanceof RateLimitError) return { ok: false, message: error.message };
    throw error;
  }
}
