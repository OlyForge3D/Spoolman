import { expect, test } from "./fixtures";
import { openToolbarMenu, unique } from "./helpers";
import { removeTestLayoutEntries } from "./dashboard-layout";
import type { APIRequestContext } from "@playwright/test";

/**
 * A dashboard card shows its spools a page at a time and fetches the next page
 * when its list is scrolled to the bottom. The card's height cap has to stay
 * below one page of spools for that to work: on a tall screen a card that fits
 * its whole first page has no scrollbar, so the rest would never load (#1242).
 */

const API_BASE = process.env.SPOOLMAN_API_URL ?? `${process.env.SPOOLMAN_BASE_URL ?? "http://localhost:8001"}/api/v1`;

type Groups = Record<string, string[]>;
type Orders = Record<string, Record<string, number[]>>;

async function readLayout(request: APIRequestContext): Promise<{ groups: Groups; orders: Orders }> {
  const response = await request.get(`${API_BASE}/setting/`);
  expect(response.ok()).toBeTruthy();
  const settings = await response.json();
  return {
    groups: JSON.parse(settings.dashboard_groups.value) as Groups,
    orders: JSON.parse(settings.dashboard_spoolorders.value) as Orders,
  };
}

async function writeSetting(request: APIRequestContext, key: string, value: unknown): Promise<void> {
  const response = await request.post(`${API_BASE}/setting/${key}`, {
    headers: { "content-type": "application/json" },
    data: JSON.stringify(JSON.stringify(value)),
  });
  expect(response.ok()).toBeTruthy();
}

test.use({ viewport: { width: 1920, height: 2160 } });

test("a failed layout load blocks changes until retry succeeds", async ({ page }) => {
  let fail = true;
  let writes = 0;
  await page.route("**/api/v1/setting/", (route) =>
    fail ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" }) : route.fallback(),
  );
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/api/v1/setting/dashboard_")) writes++;
  });
  await page.goto("/dashboard?by=location");
  const warning = page.getByRole("alert").filter({ hasText: "saved dashboard layout could not be loaded" });
  await expect(warning).toBeVisible();
  await expect(page.getByRole("button", { name: "New group", exact: true })).toBeDisabled();
  expect(writes).toBe(0);
  fail = false;
  await warning.getByRole("button", { name: "Retry" }).click();
  await expect(warning).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New group", exact: true })).toBeEnabled();
});

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
    await card.scrollIntoViewIfNeeded();
    await expect(body.locator(".chip")).toHaveCount(30);

    await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(body.locator(".chip")).toHaveCount(40);
  } finally {
    if (!page.isClosed()) await page.close();
    await removeTestLayoutEntries(request, [location]);
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
    const { groups } = await readLayout(request);
    groups.location = [firstLocation, secondLocation, ...(groups.location ?? [])];
    await writeSetting(request, "dashboard_groups", groups);
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
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    await removeTestLayoutEntries(request, [firstLocation, secondLocation]);
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
    await from.scrollIntoViewIfNeeded();
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
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    await removeTestLayoutEntries(request, [oldLocation, newLocation, otherLocation]);
    for (const id of ids) await request.delete(`${API_BASE}/spool/${id}`);
    await request.delete(`${API_BASE}/filament/${filamentId}`);
  }
});

test("a lost rename response warns and refreshes the board instead of claiming failure", async ({ page, request }) => {
  const oldLocation = unique("Lost response from");
  const newLocation = unique("Lost response to");
  const filament = await request.post(`${API_BASE}/filament`, {
    data: { name: unique("Lost response filament"), density: 1.24, diameter: 1.75 },
  });
  expect(filament.ok()).toBeTruthy();
  const filamentId = (await filament.json()).id;
  const spool = await request.post(`${API_BASE}/spool`, { data: { filament_id: filamentId, location: oldLocation } });
  expect(spool.ok()).toBeTruthy();
  const spoolId = (await spool.json()).id;
  try {
    await page.route("**/api/v1/spool/field/location", async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBeTruthy();
      await route.abort("connectionreset");
    });
    await page.goto("/dashboard?by=location");
    const from = page.locator(".card").filter({ has: page.getByText(oldLocation, { exact: true }) });
    await from.scrollIntoViewIfNeeded();
    await expect(from.locator(".chip").filter({ hasText: `#${spoolId}` })).toBeVisible();
    await from.locator(".card-name").click();
    const name = page.locator(".card-name-input");
    await name.fill(newLocation);
    await name.press("Enter");
    await expect(page.locator(".rename-error")).toContainText("The rename may still complete");
    const renamed = page.locator(".card").filter({ has: page.getByText(newLocation, { exact: true }) });
    await expect(renamed.locator(".chip").filter({ hasText: `#${spoolId}` })).toBeVisible();
    expect((await (await request.get(`${API_BASE}/spool/${spoolId}`)).json()).location).toBe(newLocation);
  } finally {
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    await removeTestLayoutEntries(request, [oldLocation, newLocation]);
    await request.delete(`${API_BASE}/spool/${spoolId}`);
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
      if (armed) {
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
    await from.scrollIntoViewIfNeeded();
    await expect(from.locator(".chip").filter({ hasText: `#${ids[0]}` })).toBeVisible();
    await destination.scrollIntoViewIfNeeded();
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
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    await removeTestLayoutEntries(request, [oldLocation, newLocation, otherLocation]);
    for (const id of ids) await request.delete(`${API_BASE}/spool/${id}`);
    await request.delete(`${API_BASE}/filament/${filamentId}`);
  }
});

test("a rename finishing after navigation preserves the latest saved layout", async ({ page, request }) => {
  const oldLocation = unique("Navigate from");
  const newLocation = unique("Navigate to");
  const addedGroup = unique("Added while away");
  const otherField = `extra.test_${Date.now().toString(36)}`;
  const otherGroup = unique("Keep this group");
  const filament = await request.post(`${API_BASE}/filament`, {
    data: { name: unique("Navigate filament"), density: 1.24, diameter: 1.75 },
  });
  expect(filament.ok()).toBeTruthy();
  const filamentId = (await filament.json()).id;
  const spool = await request.post(`${API_BASE}/spool`, { data: { filament_id: filamentId, location: oldLocation } });
  expect(spool.ok()).toBeTruthy();
  const spoolId = (await spool.json()).id;
  const before = await readLayout(request);
  await writeSetting(request, "dashboard_groups", {
    ...before.groups,
    location: [...(before.groups.location ?? []), oldLocation],
  });
  await writeSetting(request, "dashboard_spoolorders", {
    ...before.orders,
    location: { ...before.orders.location, [oldLocation]: [spoolId] },
  });

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
    await from.scrollIntoViewIfNeeded();
    await expect(from.locator(".chip").filter({ hasText: `#${spoolId}` })).toBeVisible();
    await from.locator(".card-name").click();
    const name = page.locator(".card-name-input");
    await name.fill(newLocation);
    await name.press("Enter");
    await expect.poll(() => committed).toBe(true);

    await page.getByRole("link", { name: "Library", exact: true }).click();
    await expect(page).toHaveTitle("Library | Spoolman");
    const latest = await readLayout(request);
    await writeSetting(request, "dashboard_groups", {
      ...latest.groups,
      location: [...(latest.groups.location ?? []), addedGroup],
      [otherField]: [otherGroup],
    });
    await writeSetting(request, "dashboard_spoolorders", {
      ...latest.orders,
      location: { ...latest.orders.location, [oldLocation]: [spoolId, 99999] },
      [otherField]: { [otherGroup]: [12345] },
    });
    releaseRename();

    await expect
      .poll(async () => {
        const { groups, orders } = await readLayout(request);
        return {
          oldGroup: groups.location?.includes(oldLocation),
          newGroup: groups.location?.includes(newLocation),
          addedGroup: groups.location?.includes(addedGroup),
          otherGroups: groups[otherField],
          oldOrder: orders.location?.[oldLocation],
          newOrder: orders.location?.[newLocation],
          otherOrders: orders[otherField],
        };
      })
      .toEqual({
        oldGroup: false,
        newGroup: true,
        addedGroup: true,
        otherGroups: [otherGroup],
        oldOrder: undefined,
        newOrder: [spoolId, 99999],
        otherOrders: { [otherGroup]: [12345] },
      });
  } finally {
    releaseRename();
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    await removeTestLayoutEntries(request, [oldLocation, newLocation, addedGroup], [otherField]);
    await request.delete(`${API_BASE}/spool/${spoolId}`);
    await request.delete(`${API_BASE}/filament/${filamentId}`);
  }
});

test("switching groupings during a rename preserves both layouts", async ({ page, request }) => {
  const fieldKey = `rename_switch_${Date.now().toString(36)}`;
  const fieldName = unique("Switch grouping");
  const oldLocation = unique("Switch from");
  const newLocation = unique("Switch to");
  const rack = unique("Rack");
  const field = await request.post(`${API_BASE}/field/spool/${fieldKey}`, {
    data: { name: fieldName, order: 0, field_type: "text" },
  });
  expect(field.ok()).toBeTruthy();
  const filament = await request.post(`${API_BASE}/filament`, {
    data: { name: unique("Switch filament"), density: 1.24, diameter: 1.75 },
  });
  const filamentId = (await filament.json()).id;
  const spool = await request.post(`${API_BASE}/spool`, {
    data: { filament_id: filamentId, location: oldLocation, extra: { [fieldKey]: JSON.stringify(rack) } },
  });
  const spoolId = (await spool.json()).id;
  const before = await readLayout(request);
  const customField = `extra.${fieldKey}`;
  await writeSetting(request, "dashboard_groups", {
    ...before.groups,
    location: [...(before.groups.location ?? []), oldLocation],
    [customField]: [rack],
  });
  await writeSetting(request, "dashboard_spoolorders", {
    ...before.orders,
    location: { ...before.orders.location, [oldLocation]: [spoolId] },
    [customField]: { [rack]: [spoolId] },
  });
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
    await from.scrollIntoViewIfNeeded();
    await expect(from.locator(".chip").filter({ hasText: `#${spoolId}` })).toBeVisible();
    await from.locator(".card-name").click();
    await page.locator(".card-name-input").fill(newLocation);
    await page.locator(".card-name-input").press("Enter");
    await expect.poll(() => committed).toBe(true);

    await page.locator(".group-btn").click();
    await page.getByRole("button", { name: fieldName, exact: true }).click();
    await expect(page.getByText(rack, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New group", exact: true }).click();
    await expect.poll(async () => (await readLayout(request)).groups[customField]?.includes("New group 1")).toBe(true);
    releaseRename();
    await page.locator(".group-btn").click();
    await page.getByRole("button", { name: "Location", exact: true }).click();

    const renamed = page.locator(".card").filter({ has: page.getByText(newLocation, { exact: true }) });
    await renamed.scrollIntoViewIfNeeded();
    await expect(renamed.locator(".chip").filter({ hasText: `#${spoolId}` })).toBeVisible();
    await expect
      .poll(async () => {
        const { groups, orders } = await readLayout(request);
        return {
          old: groups.location?.includes(oldLocation),
          renamed: groups.location?.includes(newLocation),
          custom: groups[customField]?.filter((key) => key !== ""),
          locationOrder: orders.location?.[newLocation],
          customOrder: orders[customField]?.[rack],
        };
      })
      .toEqual({
        old: false,
        renamed: true,
        custom: [rack, "New group 1"],
        locationOrder: [spoolId],
        customOrder: [spoolId],
      });
  } finally {
    releaseRename();
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    await removeTestLayoutEntries(request, [oldLocation, newLocation], [customField]);
    await request.delete(`${API_BASE}/spool/${spoolId}`);
    await request.delete(`${API_BASE}/filament/${filamentId}`);
    await request.delete(`${API_BASE}/field/spool/${fieldKey}`);
  }
});

test("library groups and filament details refresh when a pending rename finishes", async ({ page, request }) => {
  page.setDefaultTimeout(5000);
  const oldLocation = unique("Library rename from");
  const newLocation = unique("Library rename to");
  const otherLocation = unique("Library other");
  const filamentName = unique("Library rename filament");
  const filament = await request.post(`${API_BASE}/filament`, {
    data: { name: filamentName, material: "PLA", density: 1.24, diameter: 1.75, weight: 1000 },
  });
  expect(filament.ok()).toBeTruthy();
  const filamentId = (await filament.json()).id as number;
  const ids: number[] = [];
  let releaseRename = () => {};
  const pending = new Promise<void>((resolve) => (releaseRename = resolve));
  let started = false;
  try {
    for (const location of [oldLocation, otherLocation]) {
      const spool = await request.post(`${API_BASE}/spool`, { data: { filament_id: filamentId, location } });
      expect(spool.ok()).toBeTruthy();
      ids.push((await spool.json()).id as number);
    }
    await page.route("**/api/v1/spool/field/location", async (route) => {
      started = true;
      await pending;
      return route.fallback();
    });
    await page.goto("/dashboard?by=location");
    const from = page.locator(".card").filter({ has: page.getByText(oldLocation, { exact: true }) });
    await from.scrollIntoViewIfNeeded();
    await expect(from.locator(".chip").filter({ hasText: `#${ids[0]}` })).toBeVisible();
    await from.locator(".card-name").click();
    await page.locator(".card-name-input").fill(newLocation);
    await page.locator(".card-name-input").press("Enter");
    await expect.poll(() => started).toBe(true);

    const other = page.locator(".card").filter({ has: page.getByText(otherLocation, { exact: true }) });
    await other.scrollIntoViewIfNeeded();
    await other
      .locator(".chip")
      .filter({ hasText: `#${ids[1]}` })
      .click();
    await expect(page).toHaveTitle("Library | Spoolman");
    const filter = await openToolbarMenu(page, "Filter");
    await filter.getByRole("button", { name: "Filament", exact: true }).click();
    await filter.getByRole("menuitemcheckbox").filter({ hasText: filamentName }).click();
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    const menu = await openToolbarMenu(page, "Group");
    await menu.getByRole("button", { name: "Location", exact: true }).click();
    await expect(page.locator(".groups .header").getByText(oldLocation, { exact: true })).toBeVisible();
    await page.locator(".insp").getByRole("link", { name: filamentName, exact: true }).first().click();
    const target = page.locator(".insp .spool-row").filter({ hasText: `#${ids[0]}` });
    await expect(target).toBeVisible();
    await expect(target).toContainText("Needs refresh");

    releaseRename();
    await expect(target.locator(".loc")).toHaveText(newLocation);
    await expect(page.locator(".groups .header").getByText(newLocation, { exact: true })).toBeVisible();
    await expect(page.locator(".groups .header").getByText(oldLocation, { exact: true })).toHaveCount(0);
  } finally {
    releaseRename();
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    await removeTestLayoutEntries(request, [oldLocation, newLocation, otherLocation]);
    for (const id of ids) await request.delete(`${API_BASE}/spool/${id}`);
    await request.delete(`${API_BASE}/filament/${filamentId}`);
  }
});

test("an open inspector refreshes saved empty locations when a rename finishes", async ({ page, request }) => {
  const oldLocation = unique("Empty location from");
  const newLocation = unique("Empty location to");
  const spoolLocation = unique("Existing spool location");
  const filament = await request.post(`${API_BASE}/filament`, {
    data: { name: unique("Location choices filament"), density: 1.24, diameter: 1.75 },
  });
  expect(filament.ok()).toBeTruthy();
  const filamentId = (await filament.json()).id as number;
  let spoolId: number | undefined;
  let releaseSave = () => {};
  const pending = new Promise<void>((resolve) => (releaseSave = resolve));
  let holding = false;
  let armed = false;
  try {
    const spool = await request.post(`${API_BASE}/spool`, {
      data: { filament_id: filamentId, location: spoolLocation },
    });
    expect(spool.ok()).toBeTruthy();
    spoolId = (await spool.json()).id as number;
    const before = await readLayout(request);
    await writeSetting(request, "dashboard_groups", {
      ...before.groups,
      location: [...(before.groups.location ?? []), oldLocation],
    });
    await page.route("**/api/v1/setting/dashboard_groups", async (route) => {
      if (armed && route.request().method() === "POST") {
        holding = true;
        await pending;
      }
      return route.fallback();
    });
    await page.goto("/dashboard?by=location");
    const from = page.locator(".card").filter({ has: page.getByText(oldLocation, { exact: true }) });
    await from.scrollIntoViewIfNeeded();
    await from.locator(".card-name").click();
    await page.locator(".card-name-input").fill(newLocation);
    armed = true;
    await page.locator(".card-name-input").press("Enter");
    await expect.poll(() => holding).toBe(true);
    const existing = page.locator(".card").filter({ has: page.getByText(spoolLocation, { exact: true }) });
    await existing.scrollIntoViewIfNeeded();
    await existing
      .locator(".chip")
      .filter({ hasText: `#${spoolId}` })
      .click();
    const location = page.locator(".insp").getByRole("combobox", { name: "Location", exact: true });
    await location.click();
    await expect(page.getByRole("option", { name: oldLocation, exact: true })).toBeVisible();
    releaseSave();
    await expect(page.getByRole("option", { name: newLocation, exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: oldLocation, exact: true })).toHaveCount(0);
  } finally {
    releaseSave();
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    await removeTestLayoutEntries(request, [oldLocation, newLocation, spoolLocation]);
    if (spoolId !== undefined) await request.delete(`${API_BASE}/spool/${spoolId}`);
    await request.delete(`${API_BASE}/filament/${filamentId}`);
  }
});

test("a page loaded during staged recovery survives the retry", async ({ page, request }) => {
  test.setTimeout(60_000);
  const fromLocation = unique("Recovery page from");
  const toLocation = unique("Recovery page to");
  const pagedLocation = unique("Recovery page other");
  const filament = await request.post(`${API_BASE}/filament`, {
    data: { name: unique("Recovery page filament"), density: 1.24, diameter: 1.75 },
  });
  const filamentId = (await filament.json()).id;
  const ids: number[] = [];
  for (const location of [fromLocation, ...Array.from({ length: 35 }, () => pagedLocation)]) {
    const spool = await request.post(`${API_BASE}/spool`, { data: { filament_id: filamentId, location } });
    expect(spool.ok()).toBeTruthy();
    ids.push((await spool.json()).id);
  }
  let releasePage = () => {};
  const pagePending = new Promise<void>((resolve) => (releasePage = resolve));
  let hold = false;
  let held = false;
  let recoveryLoads = 0;
  try {
    await page.route("**/api/v1/spool?**", async (route) => {
      const params = new URL(route.request().url()).searchParams;
      if (hold && params.get("location") === `"${toLocation}"`) {
        recoveryLoads++;
        if (!held) {
          const response = await route.fetch();
          held = true;
          await pagePending;
          return route.fulfill({ response });
        }
      }
      return route.fallback();
    });
    await page.goto("/dashboard?by=location");
    const from = page.locator(".card").filter({ has: page.getByText(fromLocation, { exact: true }) });
    const other = page.locator(".card").filter({ has: page.getByText(pagedLocation, { exact: true }) });
    await from.scrollIntoViewIfNeeded();
    await expect(from.locator(".chip").filter({ hasText: `#${ids[0]}` })).toBeVisible();
    await other.scrollIntoViewIfNeeded();
    await expect(other.locator(".chip")).toHaveCount(30);
    await from.scrollIntoViewIfNeeded();
    await from.locator(".card-name").click();
    await page.locator(".card-name-input").fill(toLocation);
    hold = true;
    await page.locator(".card-name-input").press("Enter");
    await expect.poll(() => held).toBe(true);

    await other.scrollIntoViewIfNeeded();
    await other.locator(".card-body").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(other.locator(".chip")).toHaveCount(35);
    releasePage();
    await expect.poll(() => recoveryLoads).toBeGreaterThanOrEqual(2);
    await expect(other.locator(".chip")).toHaveCount(35);
    const renamed = page.locator(".card").filter({ has: page.getByText(toLocation, { exact: true }) });
    await expect(renamed.locator(".chip").filter({ hasText: `#${ids[0]}` })).toBeVisible();
  } finally {
    releasePage();
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    await removeTestLayoutEntries(request, [fromLocation, toLocation, pagedLocation]);
    for (const id of ids) await request.delete(`${API_BASE}/spool/${id}`);
    await request.delete(`${API_BASE}/filament/${filamentId}`);
  }
});

test("a rename retains loaded pages and does not restore the old group during recovery", async ({ page, request }) => {
  test.setTimeout(60_000);
  const oldLocation = unique("Paged rename from");
  const newLocation = unique("Paged rename to");
  const filament = await request.post(`${API_BASE}/filament`, {
    data: { name: unique("Paged rename filament"), density: 1.24, diameter: 1.75 },
  });
  expect(filament.ok()).toBeTruthy();
  const filamentId = (await filament.json()).id;
  const ids: number[] = [];
  for (let i = 0; i < 65; i++) {
    const spool = await request.post(`${API_BASE}/spool`, { data: { filament_id: filamentId, location: oldLocation } });
    expect(spool.ok()).toBeTruthy();
    ids.push((await spool.json()).id);
  }
  let releaseGroups = () => {};
  const groupsPending = new Promise<void>((resolve) => (releaseGroups = resolve));
  let holdGroups = false;
  let groupsHeld = false;
  let stagedLimit = 0;
  try {
    await page.route("**/api/v1/spool/group**", async (route) => {
      if (holdGroups && !groupsHeld) {
        const response = await route.fetch();
        groupsHeld = true;
        await groupsPending;
        return route.fulfill({ response });
      }
      return route.fallback();
    });
    await page.route("**/api/v1/spool?**", async (route) => {
      const params = new URL(route.request().url()).searchParams;
      if (groupsHeld && params.get("location") === `"${newLocation}"`) {
        stagedLimit = Math.max(stagedLimit, Number(params.get("limit")));
      }
      return route.fallback();
    });
    await page.goto("/dashboard?by=location");
    const from = page.locator(".card").filter({ has: page.getByText(oldLocation, { exact: true }) });
    await from.scrollIntoViewIfNeeded();
    const body = from.locator(".card-body");
    await expect(body.locator(".chip")).toHaveCount(30);
    await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(body.locator(".chip")).toHaveCount(60);
    await from.locator(".card-name").click();
    const name = page.locator(".card-name-input");
    await name.fill(newLocation);
    holdGroups = true;
    await name.press("Enter");
    await expect.poll(() => groupsHeld).toBe(true);
    await expect.poll(async () => (await readLayout(request)).groups.location?.includes(oldLocation)).toBe(false);
    releaseGroups();

    await expect.poll(() => stagedLimit).toBeGreaterThanOrEqual(60);
    const renamed = page.locator(".card").filter({ has: page.getByText(newLocation, { exact: true }) });
    await renamed.scrollIntoViewIfNeeded();
    await expect(renamed.locator(".chip")).toHaveCount(60);
    await expect(page.getByText(oldLocation, { exact: true })).toHaveCount(0);
    await renamed.locator(".card-body").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(renamed.locator(".chip")).toHaveCount(65);
  } finally {
    releaseGroups();
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    await removeTestLayoutEntries(request, [oldLocation, newLocation]);
    for (const id of ids) await request.delete(`${API_BASE}/spool/${id}`);
    await request.delete(`${API_BASE}/filament/${filamentId}`);
  }
});

test("a discarded recovery page cannot resurrect a deleted spool in the inspector", async ({ page, request }) => {
  const oldLocation = unique("Deleted rename from");
  const newLocation = unique("Deleted rename to");
  const filament = await request.post(`${API_BASE}/filament`, {
    data: { name: unique("Deleted rename filament"), density: 1.24, diameter: 1.75 },
  });
  expect(filament.ok()).toBeTruthy();
  const filamentId = (await filament.json()).id;
  const spool = await request.post(`${API_BASE}/spool`, { data: { filament_id: filamentId, location: oldLocation } });
  expect(spool.ok()).toBeTruthy();
  const spoolId = (await spool.json()).id;
  let releaseGroups = () => {};
  const groupsPending = new Promise<void>((resolve) => (releaseGroups = resolve));
  let releasePage = () => {};
  const pagePending = new Promise<void>((resolve) => (releasePage = resolve));
  let holdGroups = false;
  let groupsHeld = false;
  let holdPage = false;
  let pageHeld = false;
  let groupRequests = 0;
  try {
    await page.route("**/api/v1/spool/group**", async (route) => {
      if (holdGroups) groupRequests++;
      if (holdGroups) {
        const response = await route.fetch();
        groupsHeld = true;
        await groupsPending;
        return route.fulfill({ response });
      }
      return route.fallback();
    });
    await page.route("**/api/v1/spool?**", async (route) => {
      const location = new URL(route.request().url()).searchParams.get("location");
      if (holdPage && !pageHeld && location === `"${newLocation}"`) {
        const response = await route.fetch();
        pageHeld = true;
        await pagePending;
        return route.fulfill({ response });
      }
      return route.fallback();
    });
    await page.goto("/dashboard?by=location");
    const from = page.locator(".card").filter({ has: page.getByText(oldLocation, { exact: true }) });
    await from.scrollIntoViewIfNeeded();
    await expect(from.locator(".chip").filter({ hasText: `#${spoolId}` })).toBeVisible();
    await from.locator(".card-name").click();
    const name = page.locator(".card-name-input");
    await name.fill(newLocation);
    holdGroups = true;
    await name.press("Enter");
    await expect.poll(() => groupsHeld).toBe(true);
    const renamed = page.locator(".card").filter({ has: page.getByText(newLocation, { exact: true }) });
    await renamed.scrollIntoViewIfNeeded();
    await expect(renamed.locator(".chip").filter({ hasText: `#${spoolId}` })).toBeVisible();
    holdPage = true;
    releaseGroups();
    await expect.poll(() => pageHeld).toBe(true);
    expect((await request.delete(`${API_BASE}/spool/${spoolId}`)).ok()).toBeTruthy();
    await expect(renamed.locator(".chip").filter({ hasText: `#${spoolId}` })).toHaveCount(0);
    releasePage();
    await expect.poll(() => groupRequests).toBeGreaterThanOrEqual(2);

    await page.evaluate((id) => {
      const link = document.createElement("a");
      link.href = `/?sel=spool:${id}`;
      link.id = "deleted-spool-link";
      link.textContent = "Open deleted spool";
      document.body.appendChild(link);
    }, spoolId);
    await page.locator("#deleted-spool-link").click();
    await expect(page.getByText("This item could not be found. It may have been deleted.")).toBeVisible();
  } finally {
    releaseGroups();
    releasePage();
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
    await removeTestLayoutEntries(request, [oldLocation, newLocation]);
    await request.delete(`${API_BASE}/spool/${spoolId}`);
    await request.delete(`${API_BASE}/filament/${filamentId}`);
  }
});
