import { expect, test } from "./fixtures";
import { unique } from "./helpers";

/**
 * A dashboard card shows its spools a page at a time and fetches the next page
 * when its list is scrolled to the bottom. The card's height cap has to stay
 * below one page of spools for that to work: on a tall screen a card that fits
 * its whole first page has no scrollbar, so the rest would never load (#1242).
 */

const API_BASE =
  process.env.SPOOLMAN_API_URL ?? `${process.env.SPOOLMAN_BASE_URL ?? "http://localhost:8001"}/api/v1`;

test.use({ viewport: { width: 1920, height: 2160 } });

test("a big group's card loads every spool on a tall screen", async ({ page, request }) => {
  const location = unique("Rack");
  const res = await request.post(`${API_BASE}/filament`, {
    data: { name: unique("Filament"), density: 1.24, diameter: 1.75 },
  });
  expect(res.ok()).toBeTruthy();
  const filamentId = (await res.json()).id;
  // More than one page of spools (30).
  const ids: number[] = [];
  for (let i = 0; i < 40; i++) {
    const spool = await request.post(`${API_BASE}/spool`, { data: { filament_id: filamentId, location } });
    expect(spool.ok()).toBeTruthy();
    ids.push((await spool.json()).id);
  }

  try {
    await page.goto("/dashboard?by=location");
    const card = page.locator(".card").filter({ has: page.getByText(location, { exact: true }) });
    const body = card.locator(".card-body");
    await expect(body.locator(".chip")).toHaveCount(30);

    await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(body.locator(".chip")).toHaveCount(40);
  } finally {
    // Leave the shared database as the other specs expect it.
    for (const id of ids) await request.delete(`${API_BASE}/spool/${id}`);
    await request.delete(`${API_BASE}/filament/${filamentId}`);
  }
});

test("a failed drag keeps the board and offers a retry when refresh also fails", async ({ page, request }) => {
  const firstLocation = unique("From");
  const secondLocation = unique("To");
  const filament = await request.post(`${API_BASE}/filament`, {
    data: { name: unique("Drag filament"), density: 1.24, diameter: 1.75 },
  });
  expect(filament.ok()).toBeTruthy();
  const filamentId = (await filament.json()).id;
  const ids: number[] = [];
  for (const location of [firstLocation, secondLocation]) {
    const spool = await request.post(`${API_BASE}/spool`, { data: { filament_id: filamentId, location } });
    expect(spool.ok()).toBeTruthy();
    ids.push((await spool.json()).id);
  }

  let failRefresh = false;
  let failPages = false;
  let failedPages = 0;
  try {
    await page.route("**/api/v1/spool/group**", async (route) => {
      if (failRefresh) return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      return route.fallback();
    });
    await page.route("**/api/v1/spool?**", async (route) => {
      if (failPages && route.request().method() === "GET") {
        failedPages++;
        return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      }
      return route.fallback();
    });
    await page.route(`**/api/v1/spool/${ids[0]}`, async (route) => {
      if (route.request().method() === "PATCH") {
        failRefresh = true;
        return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      }
      return route.fallback();
    });
    await page.goto("/dashboard?by=location");
    const source = page.locator(".card").filter({ has: page.getByText(firstLocation, { exact: true }) });
    const target = page.locator(".card").filter({ has: page.getByText(secondLocation, { exact: true }) });
    const chip = source.locator(".chip").filter({ hasText: `#${ids[0]}` });
    await expect(chip).toBeVisible();
    await expect(target.locator(".chip")).toBeVisible();

    const from = await chip.boundingBox();
    const to = await target.locator(".card-body").boundingBox();
    if (!from || !to) throw new Error("The drag source or target has no bounding box");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
    // The drag library observes drop zones on an animation-duration interval.
    await page.waitForTimeout(400);
    await page.mouse.up();

    await expect(page.locator(".toaster .error")).toContainText("503");
    const warning = page.getByRole("alert").filter({ hasText: "dashboard could not be refreshed" });
    await expect(warning).toBeVisible();
    await expect(source.locator(".chip").filter({ hasText: `#${ids[0]}` })).toBeVisible();
    await expect(target.locator(".chip").filter({ hasText: `#${ids[0]}` })).toHaveCount(0);
    await expect(target.locator(".chip").filter({ hasText: `#${ids[1]}` })).toBeVisible();
    failRefresh = false;
    failPages = true;
    await warning.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => failedPages).toBeGreaterThan(0);
    await expect(warning).toBeVisible();
    await expect(source.locator(".chip").filter({ hasText: `#${ids[0]}` })).toBeVisible();
    await expect(target.locator(".chip").filter({ hasText: `#${ids[1]}` })).toBeVisible();
    failPages = false;
    await warning.getByRole("button", { name: "Retry" }).click();
    await expect(warning).toHaveCount(0);
    await expect(source.locator(".chip").filter({ hasText: `#${ids[0]}` })).toBeVisible();
    expect((await (await request.get(`${API_BASE}/spool/${ids[0]}`)).json()).location).toBe(firstLocation);
  } finally {
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    for (const id of ids) await request.delete(`${API_BASE}/spool/${id}`);
    await request.delete(`${API_BASE}/filament/${filamentId}`);
  }
});

test("a concurrent move after a group rename stays in its server location", async ({ page, request }) => {
  const oldLocation = unique("Rename from");
  const newLocation = unique("Rename to");
  const otherLocation = unique("Other group");
  const filament = await request.post(`${API_BASE}/filament`, {
    data: { name: unique("Rename filament"), density: 1.24, diameter: 1.75 },
  });
  expect(filament.ok()).toBeTruthy();
  const filamentId = (await filament.json()).id;
  const ids: number[] = [];
  for (const location of [oldLocation, otherLocation]) {
    const spool = await request.post(`${API_BASE}/spool`, { data: { filament_id: filamentId, location } });
    expect(spool.ok()).toBeTruthy();
    ids.push((await spool.json()).id);
  }
  let releaseRename = () => {};
  const responsePending = new Promise<void>((resolve) => (releaseRename = resolve));
  let committed = false;
  try {
    await page.route("**/api/v1/spool/field/location", async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBeTruthy();
      committed = true;
      await responsePending;
      return route.fulfill({ response });
    });
    await page.goto("/dashboard?by=location");
    const from = page.locator(".card").filter({ has: page.getByText(oldLocation, { exact: true }) });
    await expect(from.locator(".chip").filter({ hasText: `#${ids[0]}` })).toBeVisible();
    await from.locator(".card-name").click();
    const name = page.locator(".card-name-input");
    await name.fill(newLocation);
    await expect(name).toHaveValue(newLocation);
    await name.press("Enter");
    await expect.poll(() => committed).toBe(true);
    const move = await request.patch(`${API_BASE}/spool/${ids[1]}`, { data: { location: oldLocation } });
    expect(move.ok()).toBeTruthy();
    const editing = page.locator(".card").filter({ has: name });
    await expect(editing.locator(".chip").filter({ hasText: `#${ids[1]}` })).toBeVisible();
    releaseRename();

    const renamed = page.locator(".card").filter({ has: page.getByText(newLocation, { exact: true }) });
    await expect(renamed.locator(".chip").filter({ hasText: `#${ids[0]}` })).toBeVisible();
    await expect(from.locator(".chip").filter({ hasText: `#${ids[1]}` })).toBeVisible();
    await expect(renamed.locator(".chip").filter({ hasText: `#${ids[1]}` })).toHaveCount(0);
    expect((await (await request.get(`${API_BASE}/spool/${ids[1]}`)).json()).location).toBe(oldLocation);
  } finally {
    releaseRename();
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    for (const id of ids) await request.delete(`${API_BASE}/spool/${id}`);
    await request.delete(`${API_BASE}/filament/${filamentId}`);
  }
});

test("a live move during a dashboard refresh is not replaced by an older page", async ({ page, request }) => {
  const oldLocation = unique("Refresh from");
  const newLocation = unique("Refresh renamed");
  const otherLocation = unique("Refresh destination");
  const filament = await request.post(`${API_BASE}/filament`, {
    data: { name: unique("Refresh filament"), density: 1.24, diameter: 1.75 },
  });
  expect(filament.ok()).toBeTruthy();
  const filamentId = (await filament.json()).id;
  const ids: number[] = [];
  for (const location of [oldLocation, otherLocation]) {
    const spool = await request.post(`${API_BASE}/spool`, { data: { filament_id: filamentId, location } });
    expect(spool.ok()).toBeTruthy();
    ids.push((await spool.json()).id);
  }

  let releaseRefresh = () => {};
  const refreshPending = new Promise<void>((resolve) => (releaseRefresh = resolve));
  let releaseGroups = () => {};
  const groupsPending = new Promise<void>((resolve) => (releaseGroups = resolve));
  let armed = false;
  let groupsHeld = false;
  let stagePage = false;
  let held = false;
  let destinationLoads = 0;
  try {
    await page.route("**/api/v1/spool/group**", async (route) => {
      if (armed && !groupsHeld) {
        const response = await route.fetch();
        groupsHeld = true;
        await groupsPending;
        return route.fulfill({ response });
      }
      return route.fallback();
    });
    await page.route("**/api/v1/spool?**", async (route) => {
      const location = new URL(route.request().url()).searchParams.get("location");
      if (stagePage && location === `"${otherLocation}"`) destinationLoads++;
      if (stagePage && !held && location === `"${newLocation}"`) {
        const response = await route.fetch();
        held = true;
        await refreshPending;
        return route.fulfill({ response });
      }
      return route.fallback();
    });
    await page.goto("/dashboard?by=location");
    const from = page.locator(".card").filter({ has: page.getByText(oldLocation, { exact: true }) });
    const destination = page.locator(".card").filter({ has: page.getByText(otherLocation, { exact: true }) });
    await expect(from.locator(".chip").filter({ hasText: `#${ids[0]}` })).toBeVisible();
    await expect(destination.locator(".chip").filter({ hasText: `#${ids[1]}` })).toBeVisible();
    await from.locator(".card-name").click();
    const name = page.locator(".card-name-input");
    await name.fill(newLocation);
    armed = true;
    await name.press("Enter");
    await expect.poll(() => groupsHeld).toBe(true);
    const renamed = page.locator(".card").filter({ has: page.getByText(newLocation, { exact: true }) });
    await renamed.scrollIntoViewIfNeeded();
    await expect(renamed.locator(".chip").filter({ hasText: `#${ids[0]}` })).toBeVisible();
    stagePage = true;
    releaseGroups();
    await expect.poll(() => held).toBe(true);

    const move = await request.patch(`${API_BASE}/spool/${ids[0]}`, { data: { location: otherLocation } });
    expect(move.ok()).toBeTruthy();
    await expect(destination.locator(".chip").filter({ hasText: `#${ids[0]}` })).toBeVisible();
    releaseRefresh();
    await expect.poll(() => destinationLoads).toBeGreaterThanOrEqual(2);
    await expect(destination.locator(".chip").filter({ hasText: `#${ids[0]}` })).toBeVisible();
    await expect(renamed.locator(".chip").filter({ hasText: `#${ids[0]}` })).toHaveCount(0);
  } finally {
    releaseRefresh();
    releaseGroups();
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    for (const id of ids) await request.delete(`${API_BASE}/spool/${id}`);
    await request.delete(`${API_BASE}/filament/${filamentId}`);
  }
});
