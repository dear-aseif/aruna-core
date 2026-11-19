import { expect, test } from "@playwright/test";

test("home page renders and exposes the PWA manifest", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Aruna" })).toBeVisible();
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);

  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  expect((await res.json()).display).toBe("standalone");
});
