import { test, expect } from "./fixtures";
import { numberField, openAddSpoolModal, openApp, unique } from "./helpers";

const API_BASE =
  process.env.SPOOLMAN_API_URL ?? `${process.env.SPOOLMAN_BASE_URL ?? "http://localhost:8001"}/api/v1`;

test("retrying a failed new-filament change does not create a second filament", async ({ page, request }) => {
  const old = await request.post(`${API_BASE}/filament`, {
    data: { name: unique("Old filament"), material: "PLA", density: 1.24, diameter: 1.75 },
  });
  expect(old.ok()).toBeTruthy();
  const oldId = (await old.json()).id;
  const spool = await request.post(`${API_BASE}/spool`, { data: { filament_id: oldId } });
  expect(spool.ok()).toBeTruthy();
  const spoolId = (await spool.json()).id;
  const name = unique("Replacement filament");
  const vendorName = unique("New manufacturer");
  let newId: number | undefined;
  let releaseFilament = () => {};
  const filamentPending = new Promise<void>((resolve) => (releaseFilament = resolve));
  try {
    await openApp(page);
    await page.goto(`/?sel=spool:${spoolId}`);
    await page.locator(".insp").getByRole("button", { name: "Change", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /^Create a new filament/ }).click();
    await dialog.getByPlaceholder("e.g. Polymaker").fill(vendorName);
    await dialog.getByPlaceholder("e.g. PolyTerra Matte Sage").fill(name);
    await dialog.getByPlaceholder("PLA", { exact: true }).fill("PLA");
    await dialog.getByRole("button", { name: /^Advanced specs/ }).click();
    await numberField(dialog, "Density").fill("1.24");

    await page.route("**/api/v1/filament", async (route) => {
      if (route.request().method() === "POST") await filamentPending;
      return route.fallback();
    });
    let failed = false;
    await page.route(`**/api/v1/spool/${spoolId}`, async (route) => {
      if (route.request().method() === "PATCH" && !failed) {
        failed = true;
        return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      }
      return route.fallback();
    });
    await dialog.getByRole("button", { name: "Change filament", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Pick an existing filament" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    releaseFilament();
    await expect(page.locator(".toaster .error")).toContainText("503");
    await expect(page.locator(".toaster .error")).toContainText("The filament was created");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByPlaceholder("e.g. PolyTerra Matte Sage")).toHaveCount(0);
    await expect(dialog).toContainText(name);
    let matches = ((await (await request.get(`${API_BASE}/filament`)).json()) as { id: number; name: string }[]).filter(
      (f) => f.name === name,
    );
    expect(matches).toHaveLength(1);
    newId = matches[0].id;

    await dialog.getByRole("button", { name: "Change filament", exact: true }).click();
    await expect(dialog).toBeHidden();
    matches = ((await (await request.get(`${API_BASE}/filament`)).json()) as { id: number; name: string }[]).filter(
      (f) => f.name === name,
    );
    expect(matches.map((f) => f.id)).toEqual([newId]);
    expect((await (await request.get(`${API_BASE}/spool/${spoolId}`)).json()).filament.id).toBe(newId);
  } finally {
    releaseFilament();
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    await request.delete(`${API_BASE}/spool/${spoolId}`);
    if (newId !== undefined) await request.delete(`${API_BASE}/filament/${newId}`);
    await request.delete(`${API_BASE}/filament/${oldId}`);
    const vendors = (await (await request.get(`${API_BASE}/vendor`)).json()) as { id: number; name: string }[];
    for (const vendor of vendors.filter((v) => v.name === vendorName)) await request.delete(`${API_BASE}/vendor/${vendor.id}`);
  }
});

test("retrying a failed spool batch reuses its newly created filament", async ({ page, request }) => {
  const name = unique("Batch filament");
  const location = unique("Batch shelf");
  const vendorName = unique("Batch manufacturer");
  let newId: number | undefined;
  let releaseFilament = () => {};
  const filamentPending = new Promise<void>((resolve) => (releaseFilament = resolve));
  try {
    await openApp(page);
    const dialog = await openAddSpoolModal(page);
    await dialog.getByRole("button", { name: /^Create a new filament/ }).click();
    await dialog.getByPlaceholder("e.g. Polymaker").fill(vendorName);
    await dialog.getByPlaceholder("e.g. PolyTerra Matte Sage").fill(name);
    await dialog.getByPlaceholder("PLA", { exact: true }).fill("PLA");
    await dialog.getByRole("button", { name: /^Advanced specs/ }).click();
    await numberField(dialog, "Density").fill("1.24");
    await numberField(dialog, "Count").fill("2");
    await dialog.getByPlaceholder("e.g. Shelf A").fill(location);

    await page.route("**/api/v1/filament", async (route) => {
      if (route.request().method() === "POST") await filamentPending;
      return route.fallback();
    });
    let posts = 0;
    await page.route("**/api/v1/spool", async (route) => {
      if (route.request().method() === "POST" && ++posts === 2) {
        return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      }
      return route.fallback();
    });
    await dialog.getByRole("button", { name: "Add 2 spools", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "use an existing one" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    releaseFilament();
    await expect(page.locator(".toaster .error")).toContainText("503");
    await expect(page.locator(".toaster .error")).toContainText("The filament was created");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByPlaceholder("e.g. PolyTerra Matte Sage")).toHaveCount(0);
    await expect(dialog).toContainText(name);
    let matches = ((await (await request.get(`${API_BASE}/filament`)).json()) as { id: number; name: string }[]).filter(
      (f) => f.name === name,
    );
    expect(matches).toHaveLength(1);
    newId = matches[0].id;

    await expect(dialog.getByRole("alert")).toContainText("1 spool was confirmed added");
    await expect(dialog.getByRole("alert")).toContainText("the last request may also have succeeded");
    await expect(numberField(dialog, "Count")).toHaveValue("1");
    await expect(dialog.getByRole("button", { name: "Add & new", exact: true })).toBeDisabled();
    await dialog.getByRole("checkbox", { name: "I checked my inventory and adjusted the remaining count." }).check();
    await dialog.getByRole("button", { name: "Add & new", exact: true }).click();
    await expect(dialog.getByText(`New filament · copy of “${name}”`)).toBeVisible();
    await expect(numberField(dialog, "Count")).toHaveValue("1");
    matches = ((await (await request.get(`${API_BASE}/filament`)).json()) as { id: number; name: string }[]).filter(
      (f) => f.name === name,
    );
    expect(matches.map((f) => f.id)).toEqual([newId]);
    const created = ((await (await request.get(`${API_BASE}/spool`)).json()) as { id: number; location: string }[]).filter(
      (s) => s.location === location,
    );
    expect(created).toHaveLength(2);
  } finally {
    releaseFilament();
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    const spools = ((await (await request.get(`${API_BASE}/spool`)).json()) as { id: number; location: string }[]).filter(
      (s) => s.location === location,
    );
    for (const spool of spools) await request.delete(`${API_BASE}/spool/${spool.id}`);
    if (newId !== undefined) await request.delete(`${API_BASE}/filament/${newId}`);
    const vendors = (await (await request.get(`${API_BASE}/vendor`)).json()) as { id: number; name: string }[];
    for (const vendor of vendors.filter((v) => v.name === vendorName)) await request.delete(`${API_BASE}/vendor/${vendor.id}`);
  }
});

test("late spool field defaults are loaded before a spool is created", async ({ page, request }) => {
  const fieldKey = `late_default_${Date.now().toString(36)}`;
  const field = await request.post(`${API_BASE}/field/spool/${fieldKey}`, {
    data: { name: "Late default", order: 0, field_type: "text", default_value: '"default value"' },
  });
  expect(field.ok()).toBeTruthy();
  const name = unique("Default filament");
  const filament = await request.post(`${API_BASE}/filament`, {
    data: { name, material: "PLA", density: 1.24, diameter: 1.75 },
  });
  expect(filament.ok()).toBeTruthy();
  const filamentId = (await filament.json()).id;
  const location = unique("Default shelf");
  const clearedLocation = unique("Cleared default shelf");
  let releaseFields = () => {};
  const fieldsPending = new Promise<void>((resolve) => (releaseFields = resolve));
  let releaseVendorFields = () => {};
  const vendorFieldsPending = new Promise<void>((resolve) => (releaseVendorFields = resolve));
  let vendorFieldsLoaded = false;
  let spoolPosts = 0;
  try {
    await page.route("**/api/v1/field/spool", async (route) => {
      if (route.request().method() === "GET") await fieldsPending;
      return route.fallback();
    });
    await page.route("**/api/v1/field/vendor", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await vendorFieldsPending;
      const response = await route.fetch();
      await route.fulfill({ response });
      vendorFieldsLoaded = true;
    });
    await page.route("**/api/v1/spool", async (route) => {
      if (route.request().method() === "POST") spoolPosts++;
      return route.fallback();
    });
    await openApp(page);
    const dialog = await openAddSpoolModal(page);
    await dialog.getByPlaceholder(/Search your catalog/).fill(name);
    await dialog.locator(".res-item").filter({ hasText: name }).first().click();
    await dialog.getByPlaceholder("e.g. Shelf A").fill(location);
    await dialog.getByRole("button", { name: "Add 1 spool", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Adding..." })).toBeDisabled();
    expect(spoolPosts).toBe(0);
    releaseFields();
    await expect(dialog).toBeHidden();
    const created = ((await (await request.get(`${API_BASE}/spool`)).json()) as {
      id: number;
      location: string;
      extra: Record<string, string>;
    }[]).filter((s) => s.location === location);
    expect(created).toHaveLength(1);
    expect(created[0].extra[fieldKey]).toBe('"default value"');

    const second = await openAddSpoolModal(page);
    await second.getByPlaceholder(/Search your catalog/).fill(name);
    await second.locator(".res-item").filter({ hasText: name }).first().click();
    await second.getByPlaceholder("e.g. Shelf A").fill(clearedLocation);
    const customField = second.getByRole("textbox", { name: "Late default" });
    await expect(customField).toHaveValue("default value");
    await customField.fill("");
    releaseVendorFields();
    await expect.poll(() => vendorFieldsLoaded).toBe(true);
    await expect(customField).toHaveValue("");
    await second.getByRole("button", { name: "Add 1 spool", exact: true }).click();
    await expect(second).toBeHidden();
    const cleared = ((await (await request.get(`${API_BASE}/spool`)).json()) as {
      id: number;
      location: string;
      extra: Record<string, string>;
    }[]).filter((s) => s.location === clearedLocation);
    expect(cleared).toHaveLength(1);
    expect(cleared[0].extra[fieldKey]).toBeUndefined();
  } finally {
    releaseFields();
    releaseVendorFields();
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    const spools = ((await (await request.get(`${API_BASE}/spool`)).json()) as { id: number; location: string }[]).filter(
      (s) => s.location === location || s.location === clearedLocation,
    );
    for (const spool of spools) await request.delete(`${API_BASE}/spool/${spool.id}`);
    await request.delete(`${API_BASE}/filament/${filamentId}`);
    await request.delete(`${API_BASE}/field/spool/${fieldKey}`);
  }
});

test("late filament and manufacturer defaults are loaded before creating them", async ({ page, request }) => {
  const suffix = Date.now().toString(36);
  const filamentKey = `filament_default_${suffix}`;
  const vendorKey = `vendor_default_${suffix}`;
  for (const [entity, key] of [
    ["filament", filamentKey],
    ["vendor", vendorKey],
  ]) {
    const response = await request.post(`${API_BASE}/field/${entity}/${key}`, {
      data: { name: `${entity} default`, order: 0, field_type: "text", default_value: `"${entity} value"` },
    });
    expect(response.ok()).toBeTruthy();
  }
  const name = unique("Default filament");
  const vendorName = unique("Default manufacturer");
  const location = unique("Default entities shelf");
  let releaseFields = () => {};
  const fieldsPending = new Promise<void>((resolve) => (releaseFields = resolve));
  let posts = 0;
  try {
    await page.route(/\/api\/v1\/field\/(filament|vendor)$/, async (route) => {
      if (route.request().method() === "GET") await fieldsPending;
      return route.fallback();
    });
    await page.route(/\/api\/v1\/(filament|vendor)$/, async (route) => {
      if (route.request().method() === "POST") posts++;
      return route.fallback();
    });
    await openApp(page);
    const dialog = await openAddSpoolModal(page);
    await dialog.getByRole("button", { name: /^Create a new filament/ }).click();
    await dialog.getByPlaceholder("e.g. Polymaker").fill(vendorName);
    await dialog.getByPlaceholder("e.g. PolyTerra Matte Sage").fill(name);
    await dialog.getByPlaceholder("PLA", { exact: true }).fill("PLA");
    await dialog.getByRole("button", { name: /^Advanced specs/ }).click();
    await numberField(dialog, "Density").fill("1.24");
    await dialog.getByPlaceholder("e.g. Shelf A").fill(location);
    await dialog.getByRole("button", { name: "Add 1 spool", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Adding..." })).toBeDisabled();
    expect(posts).toBe(0);
    releaseFields();
    await expect(dialog).toBeHidden();

    const filaments = ((await (await request.get(`${API_BASE}/filament`)).json()) as {
      id: number;
      name: string;
      extra: Record<string, string>;
      vendor: { extra: Record<string, string> };
    }[]).filter((filament) => filament.name === name);
    expect(filaments).toHaveLength(1);
    expect(filaments[0].extra[filamentKey]).toBe('"filament value"');
    expect(filaments[0].vendor.extra[vendorKey]).toBe('"vendor value"');
  } finally {
    releaseFields();
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    const spools = ((await (await request.get(`${API_BASE}/spool`)).json()) as { id: number; location: string }[]).filter(
      (spool) => spool.location === location,
    );
    for (const spool of spools) await request.delete(`${API_BASE}/spool/${spool.id}`);
    const filaments = (await (await request.get(`${API_BASE}/filament`)).json()) as { id: number; name: string }[];
    for (const filament of filaments.filter((item) => item.name === name))
      await request.delete(`${API_BASE}/filament/${filament.id}`);
    const vendors = (await (await request.get(`${API_BASE}/vendor`)).json()) as { id: number; name: string }[];
    for (const vendor of vendors.filter((item) => item.name === vendorName))
      await request.delete(`${API_BASE}/vendor/${vendor.id}`);
    await request.delete(`${API_BASE}/field/filament/${filamentKey}`);
    await request.delete(`${API_BASE}/field/vendor/${vendorKey}`);
  }
});

test("a failed spool-field load blocks creation and can be retried", async ({ page, request }) => {
  const name = unique("Field retry filament");
  const filament = await request.post(`${API_BASE}/filament`, {
    data: { name, material: "PLA", density: 1.24, diameter: 1.75 },
  });
  expect(filament.ok()).toBeTruthy();
  const filamentId = (await filament.json()).id;
  const location = unique("Field retry shelf");
  let failFields = true;
  let spoolPosts = 0;
  try {
    await page.route("**/api/v1/field/spool", async (route) => {
      if (failFields && route.request().method() === "GET") {
        return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      }
      return route.fallback();
    });
    await page.route("**/api/v1/spool", async (route) => {
      if (route.request().method() === "POST") spoolPosts++;
      return route.fallback();
    });
    await openApp(page);
    const dialog = await openAddSpoolModal(page);
    await dialog.getByPlaceholder(/Search your catalog/).fill(name);
    await dialog.locator(".res-item").filter({ hasText: name }).first().click();
    await dialog.getByPlaceholder("e.g. Shelf A").fill(location);
    await dialog.getByRole("button", { name: "Add 1 spool", exact: true }).click();
    await expect(page.locator(".toaster .error")).toContainText("Could not load custom fields");
    await expect(page.locator(".toaster .error")).toContainText("503");
    expect(spoolPosts).toBe(0);
    await expect(dialog).toBeVisible();
    failFields = false;
    await dialog.getByRole("button", { name: "Add 1 spool", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(spoolPosts).toBe(1);
  } finally {
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    const spools = ((await (await request.get(`${API_BASE}/spool`)).json()) as { id: number; location: string }[]).filter(
      (s) => s.location === location,
    );
    for (const spool of spools) await request.delete(`${API_BASE}/spool/${spool.id}`);
    await request.delete(`${API_BASE}/filament/${filamentId}`);
  }
});

test("an ambiguous spool response requires an inventory check before retry", async ({ page, request }) => {
  const name = unique("Ambiguous filament");
  const filament = await request.post(`${API_BASE}/filament`, {
    data: { name, material: "PLA", density: 1.24, diameter: 1.75 },
  });
  expect(filament.ok()).toBeTruthy();
  const filamentId = (await filament.json()).id;
  const location = unique("Ambiguous shelf");
  let intercepted = false;
  try {
    await openApp(page);
    const dialog = await openAddSpoolModal(page);
    await dialog.getByPlaceholder(/Search your catalog/).fill(name);
    await dialog.locator(".res-item").filter({ hasText: name }).first().click();
    await dialog.getByPlaceholder("e.g. Shelf A").fill(location);
    await page.route("**/api/v1/spool", async (route) => {
      if (route.request().method() === "POST" && !intercepted) {
        intercepted = true;
        const response = await route.fetch();
        expect(response.ok()).toBeTruthy();
        return route.abort("connectionreset");
      }
      return route.fallback();
    });
    await dialog.getByRole("button", { name: "Add 1 spool", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("the last request may also have succeeded");
    await expect(dialog.getByRole("button", { name: "Add 1 spool", exact: true })).toBeDisabled();
    const created = ((await (await request.get(`${API_BASE}/spool`)).json()) as { id: number; location: string }[]).filter(
      (s) => s.location === location,
    );
    expect(created).toHaveLength(1);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  } finally {
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    const spools = ((await (await request.get(`${API_BASE}/spool`)).json()) as { id: number; location: string }[]).filter(
      (s) => s.location === location,
    );
    for (const spool of spools) await request.delete(`${API_BASE}/spool/${spool.id}`);
    await request.delete(`${API_BASE}/filament/${filamentId}`);
  }
});
