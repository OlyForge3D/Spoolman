import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { navTab, unique } from "./helpers";

const API_BASE = process.env.SPOOLMAN_API_URL ?? `${process.env.SPOOLMAN_BASE_URL ?? "http://localhost:8001"}/api/v1`;

async function createRenamedSpool(page: Page, request: APIRequestContext) {
  const filamentName = unique("Quarantine filament");
  const oldLocation = unique("Quarantine old");
  const newLocation = unique("Quarantine renamed");
  const filament = await request.post(`${API_BASE}/filament`, {
    data: { name: filamentName, material: "PLA", density: 1.24, diameter: 1.75, weight: 1000 },
  });
  expect(filament.ok()).toBeTruthy();
  const filamentId = (await filament.json()).id as number;
  const spool = await request.post(`${API_BASE}/spool`, {
    data: { filament_id: filamentId, location: oldLocation, used_weight: 1 },
  });
  expect(spool.ok()).toBeTruthy();
  const spoolId = (await spool.json()).id as number;

  await page.goto("/dashboard?by=location");
  const from = page.locator(".card").filter({ has: page.getByText(oldLocation, { exact: true }) });
  await expect(from.locator(".chip").filter({ hasText: `#${spoolId}` })).toBeVisible();
  await from.locator(".card-name").click();
  const name = page.locator(".card-name-input");
  await name.fill(newLocation);
  await name.press("Enter");
  const renamed = page.locator(".card").filter({ has: page.getByText(newLocation, { exact: true }) });
  await expect(renamed.locator(".chip").filter({ hasText: `#${spoolId}` })).toBeVisible();
  return { filamentId, filamentName, spoolId, renamed };
}

async function deleteSpool(request: APIRequestContext, spoolId: number, filamentId: number) {
  await request.delete(`${API_BASE}/spool/${spoolId}`);
  await request.delete(`${API_BASE}/filament/${filamentId}`);
}

async function openTemporaryLabelDesign(page: Page) {
  await page.route("**/api/v1/setting/label_designs", (route) =>
    route.request().method() === "POST" ? route.fulfill({ json: {} }) : route.fallback(),
  );
  await navTab(page, "Labels", "Labels | Spoolman");
  const select = page.getByLabel("Select label design");
  const previous = await select.inputValue();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect.poll(() => select.inputValue()).not.toBe(previous);
}

test("a failed refresh hides the inspector without losing its pending draft", async ({ page, request }) => {
  const item = await createRenamedSpool(page, request);
  let releaseWrite = () => {};
  const writePending = new Promise<void>((resolve) => (releaseWrite = resolve));
  let writeSeen = false;
  let failReads = false;
  let failedReads = 0;
  try {
    await item.renamed
      .locator(".chip")
      .filter({ hasText: `#${item.spoolId}` })
      .click();
    await expect(page).toHaveTitle("Library | Spoolman");
    const comment = page.locator(".insp").getByRole("textbox", { name: "Comment", exact: true });
    await comment.evaluate((node) => node.setAttribute("data-original-draft", "yes"));
    const original = page.locator('[data-original-draft="yes"]');
    await page.route(`**/api/v1/spool/${item.spoolId}`, async (route) => {
      if (route.request().method() === "PATCH") {
        writeSeen = true;
        await writePending;
      } else if (route.request().method() === "GET" && failReads) {
        failedReads++;
        return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      }
      return route.fallback();
    });

    await comment.fill("Keep this inspector draft");
    await expect.poll(() => writeSeen).toBe(true);
    failReads = true;
    expect(
      (
        await request.patch(`${API_BASE}/spool/${item.spoolId}`, {
          data: { location: unique("Changed remotely") },
        })
      ).ok(),
    ).toBeTruthy();
    const warning = page.locator(".notice").filter({ hasText: "Spool details need refreshing" });
    await expect(warning).toBeVisible();
    await expect(original).toBeHidden();
    releaseWrite();
    await expect.poll(() => failedReads).toBeGreaterThan(0);

    await warning.getByRole("button", { name: "Retry" }).click();
    await expect(page.locator(".toaster .error")).toContainText("could not be confirmed");
    await expect(original).toBeHidden();
    failReads = false;
    await warning.getByRole("button", { name: "Retry" }).click();
    await expect(warning).toHaveCount(0);
    await expect(original).toBeVisible();
    await expect(original).toHaveValue("Keep this inspector draft");
  } finally {
    releaseWrite();
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    await deleteSpool(request, item.spoolId, item.filamentId);
  }
});

test("uncertain spools cannot be previewed, printed, or exported without losing selection", async ({
  page,
  request,
}) => {
  const item = await createRenamedSpool(page, request);
  let failReads = false;
  try {
    await page.route(`**/api/v1/spool/${item.spoolId}`, (route) =>
      route.request().method() === "GET" && failReads
        ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
        : route.fallback(),
    );
    await openTemporaryLabelDesign(page);
    const preview = page.getByLabel("Preview with");
    await preview.selectOption(String(item.spoolId));
    await expect(page.locator(".stage canvas").first()).toBeVisible();

    failReads = true;
    expect(
      (
        await request.patch(`${API_BASE}/spool/${item.spoolId}`, {
          data: { location: unique("Preview changed") },
        })
      ).ok(),
    ).toBeTruthy();
    let warning = page.locator(".stage .notice").filter({ hasText: "Spool details need refreshing" });
    await expect(warning).toBeVisible();
    await expect(page.locator(".stage canvas")).toHaveCount(0);
    await expect(preview).toHaveValue(String(item.spoolId));
    failReads = false;
    await warning.getByRole("button", { name: "Retry" }).click();
    await expect(warning).toHaveCount(0);
    await expect(page.locator(".stage canvas").first()).toBeVisible();
    await expect(preview).toHaveValue(String(item.spoolId));

    await page.getByRole("button", { name: "Print", exact: true }).click();
    await page.getByPlaceholder("Search spools...").fill(item.filamentName);
    const selected = page.getByRole("checkbox", { name: new RegExp(item.filamentName) });
    await selected.check();
    await expect(page.getByRole("button", { name: "Print 1 label", exact: true })).toBeEnabled();
    failReads = true;
    expect(
      (
        await request.patch(`${API_BASE}/spool/${item.spoolId}`, {
          data: { location: unique("Print changed") },
        })
      ).ok(),
    ).toBeTruthy();
    warning = page.locator(".print-panel .notice").filter({ hasText: "Spool details need refreshing" });
    await expect(warning).toBeVisible();
    await expect(selected).toBeChecked();
    await expect(page.getByRole("button", { name: "Print 1 label", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save as PNG", exact: true })).toBeDisabled();
    failReads = false;
    await warning.getByRole("button", { name: "Retry" }).click();
    await expect(warning).toHaveCount(0);
    await expect(selected).toBeChecked();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save as PNG", exact: true }).click();
    expect((await download).suggestedFilename()).toBe(`spoolman-spool-label-${item.spoolId}.png`);
  } finally {
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    await deleteSpool(request, item.spoolId, item.filamentId);
  }
});

for (const mode of ["print", "export"] as const) {
  test(`a ${mode} job stops if its spool becomes uncertain during preparation`, async ({ page, request }) => {
    const item = await createRenamedSpool(page, request);
    let failReads = false;
    let downloads = 0;
    page.on("download", () => downloads++);
    try {
      await page.route(`**/api/v1/spool/${item.spoolId}`, (route) =>
        route.request().method() === "GET" && failReads
          ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
          : route.fallback(),
      );
      await page.evaluate(() => {
        const target = window as Window & { releaseLabelLogo?: () => void; printCount?: number };
        const NativeImage = window.Image;
        const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
        if (!src?.set || !src.get) throw new Error("Cannot delay the label logo");
        const DelayedImage = function (width?: number, height?: number) {
          const image = new NativeImage(width, height);
          Object.defineProperty(image, "src", {
            configurable: true,
            get: () => src.get!.call(image) as string,
            set: (value: string) => {
              target.releaseLabelLogo = () => src.set!.call(image, value);
            },
          });
          return image;
        };
        Object.defineProperty(window, "Image", { configurable: true, writable: true, value: DelayedImage });
        window.print = () => (target.printCount = (target.printCount ?? 0) + 1);
      });
      await openTemporaryLabelDesign(page);
      await expect
        .poll(() => page.evaluate(() => typeof (window as Window & { releaseLabelLogo?: () => void }).releaseLabelLogo))
        .toBe("function");
      await page.getByRole("button", { name: "Print", exact: true }).click();
      await page.getByPlaceholder("Search spools...").fill(item.filamentName);
      await page.getByRole("checkbox", { name: new RegExp(item.filamentName) }).check();
      if (mode === "export") await page.getByRole("button", { name: "Files", exact: true }).click();
      await page
        .getByRole("button", {
          name: mode === "export" ? "Save as PNG" : "Print 1 label",
          exact: true,
        })
        .click();
      await expect(page.getByRole("button", { name: "Preparing...", exact: true })).toBeVisible();

      failReads = true;
      expect(
        (
          await request.patch(`${API_BASE}/spool/${item.spoolId}`, {
            data: { location: unique("During output") },
          })
        ).ok(),
      ).toBeTruthy();
      const warning = page.locator(".notice").filter({ hasText: "Spool details need refreshing" });
      await expect(warning).toBeVisible();
      await page.evaluate(() => {
        const release = (window as Window & { releaseLabelLogo?: () => void }).releaseLabelLogo;
        if (!release) throw new Error("The label logo was not requested");
        release();
      });
      await expect(page.locator(".toaster .error")).toContainText("Spool details changed while preparing");
      expect(downloads).toBe(0);
      expect(await page.evaluate(() => (window as Window & { printCount?: number }).printCount ?? 0)).toBe(0);
      failReads = false;
      await warning.getByRole("button", { name: "Retry" }).click();
      await expect(warning).toHaveCount(0);
    } finally {
      await page.evaluate(() => (window as Window & { releaseLabelLogo?: () => void }).releaseLabelLogo?.());
      if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
      await deleteSpool(request, item.spoolId, item.filamentId);
    }
  });
}
