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

    let failed = false;
    await page.route(`**/api/v1/spool/${spoolId}`, async (route) => {
      if (route.request().method() === "PATCH" && !failed) {
        failed = true;
        return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      }
      return route.fallback();
    });
    await dialog.getByRole("button", { name: "Change filament", exact: true }).click();
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

    let failed = false;
    await page.route("**/api/v1/spool", async (route) => {
      if (route.request().method() === "POST" && !failed) {
        failed = true;
        return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      }
      return route.fallback();
    });
    await dialog.getByRole("button", { name: "Add 2 spools", exact: true }).click();
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
