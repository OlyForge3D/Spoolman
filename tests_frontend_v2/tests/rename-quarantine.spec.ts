import { randomBytes } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { navTab, openToolbarMenu, unique } from "./helpers";
import { removeTestLayoutEntries } from "./dashboard-layout";

const API_BASE = process.env.SPOOLMAN_API_URL ?? `${process.env.SPOOLMAN_BASE_URL ?? "http://localhost:8001"}/api/v1`;

interface TestSpool {
  filamentId: number;
  spoolId?: number;
  oldLocation: string;
  newLocation: string;
}

async function createRenamedSpool(page: Page, request: APIRequestContext) {
  page.setDefaultTimeout(5000);
  const filamentName = unique("Quarantine filament");
  const oldLocation = unique("Quarantine old");
  const newLocation = unique("Quarantine renamed");
  const filament = await request.post(`${API_BASE}/filament`, {
    data: { name: filamentName, material: "PLA", density: 1.24, diameter: 1.75, weight: 1000 },
  });
  expect(filament.ok()).toBeTruthy();
  const filamentId = (await filament.json()).id as number;
  const item: TestSpool = { filamentId, oldLocation, newLocation };
  try {
    const spool = await request.post(`${API_BASE}/spool`, {
      data: { filament_id: filamentId, location: oldLocation, used_weight: 1 },
    });
    expect(spool.ok()).toBeTruthy();
    const spoolId = (await spool.json()).id as number;
    item.spoolId = spoolId;

    await page.goto("/dashboard?by=location");
    const from = page.locator(".card").filter({ has: page.getByText(oldLocation, { exact: true }) });
    await from.scrollIntoViewIfNeeded();
    await expect(from.locator(".chip").filter({ hasText: `#${spoolId}` })).toBeVisible();
    await from.locator(".card-name").click();
    const name = page.locator(".card-name-input");
    await name.fill(newLocation);
    await name.press("Enter");
    const renamed = page.locator(".card").filter({ has: page.getByText(newLocation, { exact: true }) });
    await renamed.scrollIntoViewIfNeeded();
    await expect(renamed.locator(".chip").filter({ hasText: `#${spoolId}` })).toBeVisible();
    return { ...item, filamentName, spoolId, renamed };
  } catch (error) {
    if (!page.isClosed()) await page.close();
    await deleteSpool(request, item);
    throw error;
  }
}

async function deleteSpool(request: APIRequestContext, item: TestSpool) {
  if (item.spoolId !== undefined) expect((await request.delete(`${API_BASE}/spool/${item.spoolId}`)).ok()).toBeTruthy();
  expect((await request.delete(`${API_BASE}/filament/${item.filamentId}`)).ok()).toBeTruthy();
  await removeTestLayoutEntries(request, [item.oldLocation, item.newLocation]);
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

test("rename setup loads its card in a crowded saved dashboard and cleans up", async ({ page, request }) => {
  const settings = await (await request.get(`${API_BASE}/setting/`)).json();
  const groups = JSON.parse(settings.dashboard_groups.value) as Record<string, string[]>;
  const emptyLocations = Array.from({ length: 60 }, (_, i) => unique(`Empty ${i}`));
  const crowded = { ...groups, location: [...(groups.location ?? []), ...emptyLocations] };
  const setGroups = (value: unknown) =>
    request.post(`${API_BASE}/setting/dashboard_groups`, {
      headers: { "content-type": "application/json" },
      data: JSON.stringify(JSON.stringify(value)),
    });
  let item: Awaited<ReturnType<typeof createRenamedSpool>> | undefined;
  try {
    expect((await setGroups(crowded)).ok()).toBeTruthy();
    item = await createRenamedSpool(page, request);
    await expect(item.renamed.locator(".chip").filter({ hasText: `#${item.spoolId}` })).toBeVisible();
    await navTab(page, "Library", "Library | Spoolman");
    const removed = item;
    await deleteSpool(request, removed);
    item = undefined;
    const after = await (await request.get(`${API_BASE}/setting/`)).json();
    const savedGroups = JSON.parse(after.dashboard_groups.value) as Record<string, string[]>;
    const savedOrders = JSON.parse(after.dashboard_spoolorders.value) as Record<string, Record<string, number[]>>;
    expect(savedGroups.location).not.toContain(removed.oldLocation);
    expect(savedGroups.location).not.toContain(removed.newLocation);
    expect(savedOrders.location?.[removed.oldLocation]).toBeUndefined();
    expect(savedOrders.location?.[removed.newLocation]).toBeUndefined();
  } finally {
    if (item) await deleteSpool(request, item);
    if (!page.isClosed()) await page.close();
    await removeTestLayoutEntries(request, emptyLocations);
  }
});

test("quarantine closes portaled inspector controls until the spool is verified", async ({ page, request }) => {
  const item = await createRenamedSpool(page, request);
  let failReads = false;
  let clientWrites = 0;
  try {
    await item.renamed
      .locator(".chip")
      .filter({ hasText: `#${item.spoolId}` })
      .click();
    await expect(page).toHaveTitle("Library | Spoolman");
    await page.route(`**/api/v1/spool/${item.spoolId}`, (route) => {
      if (route.request().method() === "PATCH") clientWrites++;
      if (route.request().method() === "GET" && failReads)
        return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      return route.fallback();
    });

    const firstUsed = page
      .locator(".insp .k")
      .filter({ hasText: "First Used" })
      .locator("xpath=following-sibling::div[1]")
      .locator(".trigger");
    await firstUsed.click();
    await expect(page.getByRole("dialog", { name: "Pick date and time" })).toBeVisible();
    failReads = true;
    expect(
      (await request.patch(`${API_BASE}/spool/${item.spoolId}`, { data: { location: unique("Date event") } })).ok(),
    ).toBeTruthy();
    let warning = page.locator(".notice").filter({ hasText: "Spool details need refreshing" });
    await expect(warning).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Pick date and time" })).toHaveCount(0);
    expect(clientWrites).toBe(0);
    failReads = false;
    await warning.getByRole("button", { name: "Retry" }).click();
    await expect(warning).toHaveCount(0);

    await page.locator(".insp").getByRole("combobox", { name: "Location", exact: true }).click();
    await expect(page.getByRole("listbox")).toBeVisible();
    failReads = true;
    expect(
      (await request.patch(`${API_BASE}/spool/${item.spoolId}`, { data: { location: unique("List event") } })).ok(),
    ).toBeTruthy();
    warning = page.locator(".notice").filter({ hasText: "Spool details need refreshing" });
    await expect(warning).toBeVisible();
    await expect(page.getByRole("listbox")).toHaveCount(0);
    expect(clientWrites).toBe(0);
    failReads = false;
    await warning.getByRole("button", { name: "Retry" }).click();
    await expect(warning).toHaveCount(0);
  } finally {
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    await deleteSpool(request, item);
  }
});

test("an uncached uncertain spool remains navigable in the library and dashboard", async ({ page, request }) => {
  const filamentName = unique("Uncached filament");
  const filament = await request.post(`${API_BASE}/filament`, {
    data: { name: filamentName, material: "PLA", density: 1.24, diameter: 1.75 },
  });
  expect(filament.ok()).toBeTruthy();
  const filamentId = (await filament.json()).id as number;
  const location = unique("Uncached location");
  let item: Awaited<ReturnType<typeof createRenamedSpool>> | undefined;
  let spoolId: number | undefined;
  let failReads = true;
  try {
    item = await createRenamedSpool(page, request);
    await navTab(page, "Library", "Library | Spoolman");
    const menu = await openToolbarMenu(page, "Group");
    await menu.getByRole("button", { name: "None (flat)", exact: true }).click();
    await page.route(/\/api\/v1\/spool\/\d+$/, (route) =>
      route.request().method() === "GET" && failReads
        ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
        : route.fallback(),
    );
    const spool = await request.post(`${API_BASE}/spool`, {
      data: { filament_id: filamentId, location, used_weight: 1, last_used: new Date().toISOString() },
    });
    expect(spool.ok()).toBeTruthy();
    spoolId = (await spool.json()).id as number;
    const row = page.locator(".groups .row").filter({ hasText: `#${spoolId}` });
    await expect(row).toContainText("Needs refresh");
    const grouped = await openToolbarMenu(page, "Group");
    await grouped.getByRole("button", { name: "Location", exact: true }).click();
    await expect(row).toContainText("Needs refresh");
    await row.click();
    await expect(page.locator(".insp .notice, .empty .notice")).toContainText("Spool details need refreshing");
    await navTab(page, "Dashboard", "Dashboard | Spoolman");
    const card = page.locator(".card").filter({ has: page.getByText(location, { exact: true }) });
    await card.scrollIntoViewIfNeeded();
    const chip = card.locator(".chip").filter({ hasText: `#${spoolId}` });
    await expect(chip).toContainText("Needs refresh");
    const warning = page.locator(".spool-recovery .notice");
    await expect(warning).toBeVisible();
    failReads = false;
    await warning.getByRole("button", { name: "Retry" }).click();
    await expect(warning).toHaveCount(0);
    await expect(chip).toContainText(filamentName);
  } finally {
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    if (spoolId !== undefined) expect((await request.delete(`${API_BASE}/spool/${spoolId}`)).ok()).toBeTruthy();
    expect((await request.delete(`${API_BASE}/filament/${filamentId}`)).ok()).toBeTruthy();
    if (item) await deleteSpool(request, item);
    await removeTestLayoutEntries(request, [location]);
  }
});

test("a rejected rename keeps uncached rows safe until their details can be recovered", async ({ page, request }) => {
  const item = await createRenamedSpool(page, request);
  const filamentName = unique("Rejected candidate filament");
  const failedName = unique("Rejected rename");
  const filament = await request.post(`${API_BASE}/filament`, {
    data: { name: filamentName, material: "PLA", density: 1.24, diameter: 1.75 },
  });
  expect(filament.ok()).toBeTruthy();
  const filamentId = (await filament.json()).id as number;
  let spoolId: number | undefined;
  let failReads = true;
  let renameStarted = false;
  let renameRejected = false;
  let releaseRename = () => {};
  const pending = new Promise<void>((resolve) => (releaseRename = resolve));
  try {
    await page.route("**/api/v1/spool/field/location", async (route) => {
      renameStarted = true;
      await pending;
      await route.fulfill({ status: 422, contentType: "application/json", body: "{}" });
      renameRejected = true;
    });
    await page.route(/\/api\/v1\/spool\/\d+$/, (route) =>
      route.request().method() === "GET" && failReads
        ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
        : route.fallback(),
    );
    await item.renamed.locator(".card-name").click();
    await page.locator(".card-name-input").fill(failedName);
    await page.locator(".card-name-input").press("Enter");
    await expect.poll(() => renameStarted).toBe(true);
    const spool = await request.post(`${API_BASE}/spool`, {
      data: {
        filament_id: filamentId,
        location: item.newLocation,
        used_weight: 1,
        last_used: new Date().toISOString(),
      },
    });
    expect(spool.ok()).toBeTruthy();
    spoolId = (await spool.json()).id as number;
    await navTab(page, "Library", "Library | Spoolman");
    const menu = await openToolbarMenu(page, "Group");
    await menu.getByRole("button", { name: "None (flat)", exact: true }).click();
    const row = page.locator(".groups .row").filter({ hasText: `#${spoolId}` });
    await expect(row).toContainText("Needs refresh");
    await row.click();
    const warning = page.locator(".notice").filter({ hasText: "Spool details need refreshing" });
    await expect(warning).toBeVisible();
    releaseRename();
    await expect.poll(() => renameRejected).toBe(true);
    await expect(row).toContainText("Needs refresh");
    const grouped = await openToolbarMenu(page, "Group");
    await grouped.getByRole("button", { name: "Location", exact: true }).click();
    await expect(row).toContainText("Needs refresh");
    failReads = false;
    await warning.getByRole("button", { name: "Retry" }).click();
    await expect(row).toContainText(filamentName);
    await expect(page.locator(".insp")).toContainText(filamentName);
  } finally {
    releaseRename();
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    if (spoolId !== undefined) expect((await request.delete(`${API_BASE}/spool/${spoolId}`)).ok()).toBeTruthy();
    expect((await request.delete(`${API_BASE}/filament/${filamentId}`)).ok()).toBeTruthy();
    await deleteSpool(request, item);
    await removeTestLayoutEntries(request, [failedName]);
  }
});

test("a tag cannot be moved from an uncertain spool until its details are verified", async ({ page, request }) => {
  const item = await createRenamedSpool(page, request);
  const uid = randomBytes(4).toString("hex").toUpperCase();
  const replacementName = unique("Tag replacement filament");
  const replacement = await request.post(`${API_BASE}/filament`, {
    data: { name: replacementName, material: "PLA", density: 1.24, diameter: 1.75 },
  });
  expect(replacement.ok()).toBeTruthy();
  const replacementId = (await replacement.json()).id as number;
  let failReads = false;
  let unlinks = 0;
  try {
    expect((await request.post(`${API_BASE}/spool/${item.spoolId}/tag`, { data: { uid } })).ok()).toBeTruthy();
    await item.renamed
      .locator(".chip")
      .filter({ hasText: `#${item.spoolId}` })
      .click();
    await expect(page).toHaveTitle("Library | Spoolman");
    await page.locator(".insp").getByRole("link", { name: item.filamentName, exact: true }).first().click();
    await page.locator(".insp").getByRole("button", { name: "Add tag" }).click();
    const dialog = page.getByRole("dialog", { name: "Link a tag" });
    await dialog.getByLabel("Tag UID").fill(uid);
    const move = dialog.getByRole("button", { name: `Move it here from #${item.spoolId}` });
    await expect(move).toBeEnabled();

    await page.route(`**/api/v1/spool/${item.spoolId}`, (route) =>
      route.request().method() === "GET" && failReads
        ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
        : route.fallback(),
    );
    await page.route(`**/api/v1/spool/${item.spoolId}/tag/**`, (route) => {
      if (route.request().method() === "DELETE") unlinks++;
      return route.fallback();
    });
    failReads = true;
    expect(
      (
        await request.patch(`${API_BASE}/spool/${item.spoolId}`, {
          data: { location: unique("Tag event"), filament_id: replacementId },
        })
      ).ok(),
    ).toBeTruthy();
    const warning = dialog.locator(".notice").filter({ hasText: "Spool details need refreshing" });
    await expect(warning).toBeVisible();
    await expect(move).toBeDisabled();
    await expect(dialog.locator(".status")).not.toContainText(item.filamentName);
    await dialog.getByLabel("Tag UID").press("Enter");
    expect(unlinks).toBe(0);

    failReads = false;
    await warning.getByRole("button", { name: "Retry" }).click();
    await expect(move).toBeEnabled();
    await expect(dialog.locator(".status")).toContainText(replacementName);
    await move.click();
    await expect(dialog).toBeHidden();
    const updated = await (await request.get(`${API_BASE}/filament/${item.filamentId}`)).json();
    expect(updated.tags.map((tag: { uid: string }) => tag.uid)).toContain(uid);
  } finally {
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    await deleteSpool(request, item);
    expect((await request.delete(`${API_BASE}/filament/${replacementId}`)).ok()).toBeTruthy();
  }
});

test("a tag move stops after unlink if its spool becomes uncertain", async ({ page, request }) => {
  const item = await createRenamedSpool(page, request);
  const uid = randomBytes(4).toString("hex").toUpperCase();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let unlinked!: () => void;
  const unlinkReached = new Promise<void>((resolve) => (unlinked = resolve));
  try {
    expect((await request.post(`${API_BASE}/spool/${item.spoolId}/tag`, { data: { uid } })).ok()).toBeTruthy();
    await item.renamed.locator(".chip").filter({ hasText: `#${item.spoolId}` }).click();
    await page.locator(".insp").getByRole("link", { name: item.filamentName, exact: true }).first().click();
    await page.locator(".insp").getByRole("button", { name: "Add tag" }).click();
    const dialog = page.getByRole("dialog", { name: "Link a tag" });
    await dialog.getByLabel("Tag UID").fill(uid);
    const move = dialog.getByRole("button", { name: `Move it here from #${item.spoolId}` });
    await expect(move).toBeEnabled();
    await page.route(`**/api/v1/spool/${item.spoolId}/tag/**`, async (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      const response = await route.fetch();
      unlinked();
      await gate;
      await route.fulfill({ response });
    });
    await move.click();
    await unlinkReached;
    expect(
      (await request.patch(`${API_BASE}/spool/${item.spoolId}`, { data: { location: unique("During unlink") } })).ok(),
    ).toBeTruthy();
    await expect(dialog.locator(".notice").filter({ hasText: "Spool details need refreshing" })).toBeVisible();
    release();
    await expect(dialog).toContainText("It may now be linked to nothing");
    const filament = await (await request.get(`${API_BASE}/filament/${item.filamentId}`)).json();
    expect(filament.tags.map((tag: { uid: string }) => tag.uid)).not.toContain(uid);
    const spool = await (await request.get(`${API_BASE}/spool/${item.spoolId}`)).json();
    expect(spool.tags.map((tag: { uid: string }) => tag.uid)).not.toContain(uid);
  } finally {
    release();
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    await deleteSpool(request, item);
  }
});

test("a tag scan does not announce stale details while its spool is uncertain", async ({ page, request }) => {
  const item = await createRenamedSpool(page, request);
  const uid = randomBytes(4).toString("hex").toUpperCase();
  let failReads = false;
  try {
    expect((await request.post(`${API_BASE}/spool/${item.spoolId}/tag`, { data: { uid } })).ok()).toBeTruthy();
    await navTab(page, "Settings", "Settings | Spoolman");
    const autoNavigate = page.getByLabel("Auto-navigate");
    if ((await autoNavigate.getAttribute("aria-checked")) !== "true") await autoNavigate.click();
    await navTab(page, "Dashboard", "Dashboard | Spoolman");
    await page.route(`**/api/v1/spool/${item.spoolId}`, (route) =>
      route.request().method() === "GET" && failReads
        ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
        : route.fallback(),
    );
    failReads = true;
    expect(
      (await request.patch(`${API_BASE}/spool/${item.spoolId}`, { data: { location: unique("Scan event") } })).ok(),
    ).toBeTruthy();
    await expect(page.locator(".spool-recovery .notice")).toBeVisible();
    await expect(async () => {
      const scan = await request.post(`${API_BASE}/tag/scan`, {
        data: { uid, reader_id: `uncertain-${randomBytes(4).toString("hex")}` },
      });
      expect(scan.ok()).toBeTruthy();
      await expect(page.getByRole("status")).toContainText(
        `Tag scanned: opened spool #${item.spoolId}, Needs refresh.`,
        { timeout: 1500 },
      );
    }).toPass({ timeout: 10000, intervals: [500, 1000] });
  } finally {
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    await deleteSpool(request, item);
  }
});

test("a dashboard quarantine blocks dragging and offers recovery", async ({ page, request }) => {
  await page.setViewportSize({ width: 1920, height: 2160 });
  const item = await createRenamedSpool(page, request);
  const targetLocation = unique("Quarantine target");
  const remoteLocation = unique("Quarantine moved");
  let secondId: number | undefined;
  let failReads = false;
  let clientWrites = 0;
  try {
    const second = await request.post(`${API_BASE}/spool`, {
      data: { filament_id: item.filamentId, location: targetLocation },
    });
    expect(second.ok()).toBeTruthy();
    secondId = (await second.json()).id as number;
    const target = page.locator(".card").filter({ has: page.getByText(targetLocation, { exact: true }) });
    await target.scrollIntoViewIfNeeded();
    await expect(target.locator(".chip").filter({ hasText: `#${secondId}` })).toBeVisible();
    await page.route(`**/api/v1/spool/${item.spoolId}`, (route) => {
      if (route.request().method() === "PATCH") clientWrites++;
      if (route.request().method() === "GET" && failReads)
        return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      return route.fallback();
    });
    failReads = true;
    expect(
      (await request.patch(`${API_BASE}/spool/${item.spoolId}`, { data: { location: remoteLocation } })).ok(),
    ).toBeTruthy();
    const warning = page.locator(".spool-recovery .notice");
    await expect(warning).toBeVisible();
    const chip = page.locator(".card .chip").filter({ hasText: `#${item.spoolId}` });
    const drag = async () => {
      let from = { x: 0, y: 0, width: 0, height: 0 };
      let to = { x: 0, y: 0, width: 0, height: 0 };
      await expect(async () => {
        await chip.scrollIntoViewIfNeeded();
        await target.scrollIntoViewIfNeeded();
        const source = await chip.boundingBox();
        const destination = await target.locator(".card-body").boundingBox();
        if (!source || !destination) throw new Error("Missing drag source or target");
        from = source;
        to = destination;
      }).toPass({ timeout: 5000, intervals: [100, 200, 400] });
      const viewport = page.viewportSize()!;
      expect(from.y).toBeGreaterThanOrEqual(0);
      expect(from.y + from.height).toBeLessThanOrEqual(viewport.height);
      expect(to.y).toBeGreaterThanOrEqual(0);
      expect(to.y + to.height).toBeLessThanOrEqual(viewport.height);
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
      await page.waitForTimeout(400);
      await page.mouse.up();
    };
    await drag();
    expect(clientWrites).toBe(0);
    expect((await (await request.get(`${API_BASE}/spool/${item.spoolId}`)).json()).location).toBe(remoteLocation);
    failReads = false;
    await warning.getByRole("button", { name: "Retry" }).click();
    await expect(warning).toHaveCount(0);
    const recovered = page.locator(".card").filter({ has: page.getByText(remoteLocation, { exact: true }) });
    await expect(recovered.locator(".chip").filter({ hasText: `#${item.spoolId}` })).toContainText(item.filamentName);
    await drag();
    await expect.poll(() => clientWrites).toBeGreaterThan(0);
    await expect
      .poll(async () => (await (await request.get(`${API_BASE}/spool/${item.spoolId}`)).json()).location)
      .toBe(targetLocation);
  } finally {
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    if (secondId !== undefined) expect((await request.delete(`${API_BASE}/spool/${secondId}`)).ok()).toBeTruthy();
    await deleteSpool(request, item);
    await removeTestLayoutEntries(request, [targetLocation, remoteLocation]);
  }
});

test("identical cache refreshes do not interrupt a multi-file label export", async ({ page, request }) => {
  page.setDefaultTimeout(5000);
  const item = await createRenamedSpool(page, request);
  let secondId: number | undefined;
  try {
    const second = await request.post(`${API_BASE}/spool`, {
      data: { filament_id: item.filamentId, location: item.newLocation },
    });
    expect(second.ok()).toBeTruthy();
    secondId = (await second.json()).id as number;
    await page.evaluate(() => {
      const original = window.setTimeout.bind(window);
      window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
        original(callback, delay === 150 ? 1500 : delay, ...args)) as typeof window.setTimeout;
    });
    await openTemporaryLabelDesign(page);
    await page.getByRole("button", { name: "Print", exact: true }).click();
    const search = page.getByPlaceholder("Search spools...");
    await search.fill(item.filamentName);
    const selected = page.getByRole("checkbox", { name: new RegExp(item.filamentName) });
    await expect(selected).toHaveCount(2);
    await selected.nth(0).check();
    await selected.nth(1).check();
    await page.getByRole("button", { name: "Files", exact: true }).click();
    const firstDownload = page.waitForEvent("download", { timeout: 5000 });
    await page.getByRole("button", { name: "Save as PNG", exact: true }).click();
    await firstDownload;
    const refresh = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return url.pathname.endsWith("/api/v1/spool") && url.searchParams.has("filament.id");
      },
      { timeout: 5000 },
    );
    const secondDownload = page.waitForEvent("download", { timeout: 5000 });
    await search.fill(`${item.filamentName} `);
    await refresh;
    expect((await secondDownload).suggestedFilename()).toMatch(/spoolman-spool-label-\d+\.png/);
    await expect(page.locator(".toaster .error")).toHaveCount(0);
  } finally {
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    if (secondId !== undefined) expect((await request.delete(`${API_BASE}/spool/${secondId}`)).ok()).toBeTruthy();
    await deleteSpool(request, item);
  }
});

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
        await request.patch(`${API_BASE}/spool/${item.spoolId}`, { data: { location: unique("Changed remotely") } })
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
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    await deleteSpool(request, item);
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
        await request.patch(`${API_BASE}/spool/${item.spoolId}`, { data: { location: unique("Preview changed") } })
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
      (await request.patch(`${API_BASE}/spool/${item.spoolId}`, { data: { location: unique("Print changed") } })).ok(),
    ).toBeTruthy();
    warning = page.locator(".print-panel .notice").filter({ hasText: "Spool details need refreshing" });
    await expect(warning).toBeVisible();
    await expect(page.getByRole("checkbox", { name: new RegExp(`#${item.spoolId} · Needs refresh`) })).toBeChecked();
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
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    await deleteSpool(request, item);
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
        .getByRole("button", { name: mode === "export" ? "Save as PNG" : "Print 1 label", exact: true })
        .click();
      await expect(page.getByRole("button", { name: "Preparing...", exact: true })).toBeVisible();

      failReads = true;
      expect(
        (
          await request.patch(`${API_BASE}/spool/${item.spoolId}`, { data: { location: unique("During output") } })
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
      if (!page.isClosed()) {
        await page.evaluate(() => (window as Window & { releaseLabelLogo?: () => void }).releaseLabelLogo?.());
        await page.unrouteAll({ behavior: "wait" });
        await page.close();
      }
      await deleteSpool(request, item);
    }
  });
}
