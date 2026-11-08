import { expect, test } from "./fixtures";
import { unique } from "./helpers";

const API_BASE = process.env.SPOOLMAN_API_URL ?? `${process.env.SPOOLMAN_BASE_URL ?? "http://localhost:8001"}/api/v1`;

test("a failed background field load can be retried without leaving settings", async ({ page, request }) => {
  const key = `retry_fields_${Date.now().toString(36)}`;
  const name = unique("Retried field");
  const created = await request.post(`${API_BASE}/field/spool/${key}`, {
    data: { name, order: 0, field_type: "text" },
  });
  expect(created.ok()).toBeTruthy();
  let fail = true;
  try {
    await page.route("**/api/v1/field/spool", (route) =>
      fail ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" }) : route.fallback(),
    );
    await page.goto("/settings?fields=spool#extra-fields");
    const warning = page.locator(".field-error");
    await expect(warning).toContainText("Could not load custom fields");
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    await expect(page.getByText("No custom fields defined for Spool", { exact: true })).toHaveCount(0);
    fail = false;
    await warning.getByRole("button", { name: "Retry" }).click();
    await expect(warning).toHaveCount(0);
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  } finally {
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    expect((await request.delete(`${API_BASE}/field/spool/${key}`)).ok()).toBeTruthy();
  }
});
