import { expect, test } from "@playwright/test";
import { expectAccessible, signIn } from "./helpers";

const PASSWORD = "e2e-smtp-password-7c4a";

test("admins set up email under Integrations; the password stays write-only", async ({ page }) => {
  await signIn(page, "adam");
  await page.goto("/admin");
  await page.getByRole("main").getByRole("link", { name: "Integrations", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Integrations", level: 1 })).toBeVisible();
  await expectAccessible(page);

  await page.getByLabel("Send email with").selectOption("smtp");
  await page.getByLabel("Sender address").fill("logbook@example.org");
  await page.getByLabel("Mail server").fill("mail.example.org");
  await page.getByLabel("User name").fill("logbook");
  await page.getByRole("button", { name: "Save email" }).click();
  // The page's checks: a user name needs a password.
  await expect(page.getByText("Enter the password for this user name.")).toBeVisible();

  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Save email" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved email." })).toBeVisible();
  await expect(page.getByText("Stored (…7c4a)")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Stored (…7c4a)")).toBeVisible();
  expect(await page.content()).not.toContain(PASSWORD);

  // The test worker and this server only log messages.
  await page.getByRole("button", { name: "Send test email" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "NOTIFICATION_TRANSPORT is console" }),
  ).toBeVisible();
  await expectAccessible(page);
});

test("someone who is not an admin cannot open Integrations", async ({ page }) => {
  await signIn(page, "erika");
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  expect((await page.goto("/admin/integrations"))?.status()).toBe(404);
});
