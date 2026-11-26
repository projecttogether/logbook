import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "../helpers";

const TOKEN = "e2e-webhook-token-5d2c";

// Runs against the manual instance: it has no worker, so nothing is sent.
test("admins set up the webhook under Integrations; its URL stays write-only", async ({ page }) => {
  await signIn(page, "adam");
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await page.goto("/admin/integrations");
  await page.getByLabel("URL", { exact: true }).fill(`https://hooks.example.org/${TOKEN}`);
  await page.getByLabel("Signing secret", { exact: true }).fill("e2e-signing-secret-1a2b");
  await page.getByRole("button", { name: "Save webhook" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved the webhook." })).toBeVisible();
  await expect(page.getByText("Stored (https://hooks.example.org)")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Stored (https://hooks.example.org)")).toBeVisible();
  expect(await page.content()).not.toContain(TOKEN);
  await expectAccessible(page);

  // Saving again keeps the URL; removing it turns the webhook off.
  await page.getByRole("button", { name: "Save webhook" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved the webhook." })).toBeVisible();
  await expect(page.getByText("Stored (https://hooks.example.org)")).toBeVisible();
  await page.locator("#webhook-url").getByRole("button", { name: "Remove" }).click();
  await page.getByRole("button", { name: "Save webhook" }).click();
  await expect(page.getByLabel("URL", { exact: true })).toHaveValue("");
  await expect(page.getByText("Stored (…1a2b)")).toBeVisible();
});
