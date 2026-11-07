import { argosScreenshot } from "@argos-ci/playwright";
import type { Page, Request } from "@playwright/test";
import { test, expect } from "./fixtures";
import { expectAppShell } from "./helpers";
import { seedScreenshots } from "./screenshots-seed";

/**
 * Visual snapshots of the main pages, uploaded to Argos CI (argos-ci.com) which
 * diffs them against master and posts the changed ones on the pull request.
 *
 * Runs as its own Playwright project, before the functional specs, against a
 * dedicated database. It seeds a fixed dataset (or resumes an intact partial
 * seed) so IDs, names and numbers come out the same on retries. Any drift
 * between runs shows up as a false diff, so keep the seed deterministic.
 *
 * Without CI set the reporter does not upload; the images land in
 * ./screenshots/ for a local look.
 */

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

async function snap(page: Page, name: string): Promise<void> {
  // "Registered" is the server-side creation time, which the API can't set, so
  // it would change every day. Blank out its value (Field renders the label as a
  // `.k` cell with the value as its next sibling).
  await page.evaluate(() => {
    document.querySelectorAll(".k").forEach((k) => {
      if (k.textContent?.trim() === "Registered") {
        k.nextElementSibling?.setAttribute("data-visual-test", "transparent");
      }
    });
  });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await argosScreenshot(page, `${name} (${colorScheme})`, { viewports: VIEWPORTS });
  }
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await seedScreenshots(request);
});

const PAGES = [
  { path: "/", name: "library" },
  { path: "/?lots=1", name: "library with lot numbers" },
  { path: "/dashboard", name: "dashboard" },
  { path: "/labels", name: "labels" },
  { path: "/settings", name: "settings" },
  { path: "/filament/show/1", name: "filament detail" },
  { path: "/spool/show/2", name: "spool detail" },
];

// The app shell (logo) paints before any data arrives, and Argos only waits for
// aria-busy, fonts and images, so shoot only once the API has been quiet for a
// moment. Otherwise the first shot of a page catches it mid-load (an empty
// Library list) and the Registered blanking in snap() misses fields not yet rendered.
async function gotoSettled(page: Page, path: string): Promise<void> {
  let inflight = 0;
  let quietSince = 0;
  const isApi = (r: Request) => r.url().includes("/api/v1/");
  const finished = (r: Request) => {
    if (!isApi(r)) return;
    inflight--;
    quietSince = Date.now();
  };
  page.on("request", (r) => {
    if (isApi(r)) inflight++;
  });
  page.on("requestfinished", finished);
  page.on("requestfailed", finished);
  await page.goto(path);
  await expectAppShell(page);
  quietSince = Math.max(quietSince, Date.now());
  await expect
    .poll(() => inflight === 0 && Date.now() - quietSince >= 300, { intervals: [50], timeout: 15_000 })
    .toBe(true);
}

for (const { path, name } of PAGES) {
  test(`screenshot: ${name}`, async ({ page }) => {
    await gotoSettled(page, path);
    await snap(page, name);
  });
}

test("screenshot: filament print picker", async ({ page }) => {
  // Keep the temporary design in this browser only, even if the test is retried
  // before its normal cleanup runs.
  await page.route("**/api/v1/setting/label_designs", async (route) => {
    if (route.request().method() === "POST") await route.fulfill({ json: {} });
    else await route.continue();
  });
  // A fixed catalog shows the pager without changing the shared seed.
  await page.route("**/api/v1/filament?*", async (route) => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit"));
    const filaments = Array.from({ length: 101 }, (_, i) => ({
      id: 101 - i, name: `Print filament ${101 - i}`, material: "PLA", diameter: 1.75, density: 1.24,
    }));
    await route.fulfill({ json: filaments.slice(offset, offset + limit), headers: { "X-Total-Count": "101" } });
  });
  await gotoSettled(page, "/labels");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("button", { name: "Filament", exact: true }).click();
  await page.getByRole("button", { name: "Print", exact: true }).click();
  const picker = page.locator(".print-panel .col.spools");
  await expect(picker.locator(".spool-item")).toHaveCount(100);
  await expect(picker.getByRole("button", { name: "Next page" })).toBeEnabled();
  await snap(page, "filament print picker");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
});
