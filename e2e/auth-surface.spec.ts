import { expect, test } from "@playwright/test";

test("the Better Auth session API is private", async ({ request }) => {
  const response = await request.get("/api/auth/get-session");
  expect(response.status()).toBe(404);
});
