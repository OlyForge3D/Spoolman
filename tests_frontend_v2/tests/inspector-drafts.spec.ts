import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { openApp, unique } from "./helpers";

const API_BASE =
  process.env.SPOOLMAN_API_URL ?? `${process.env.SPOOLMAN_BASE_URL ?? "http://localhost:8001"}/api/v1`;

type EntityKind = "filament" | "spool" | "vendor";

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release };
}

async function createEntity(request: APIRequestContext, kind: EntityKind, extra: Record<string, string> = {}) {
  let filamentId: number | undefined;
  if (kind === "spool") {
    const filament = await request.post(`${API_BASE}/filament`, {
      data: { name: unique("Draft filament"), material: "PLA", density: 1.24, diameter: 1.75, weight: 1000 },
    });
    expect(filament.ok()).toBeTruthy();
    filamentId = (await filament.json()).id;
  }
  const body =
    kind === "vendor"
      ? { name: unique("Draft vendor"), comment: "original", extra }
      : kind === "filament"
        ? { name: unique("Draft filament"), material: "PLA", density: 1.24, diameter: 1.75, weight: 1000, extra }
        : { filament_id: filamentId, comment: "original", extra };
  const response = await request.post(`${API_BASE}/${kind}`, { data: body });
  expect(response.ok()).toBeTruthy();
  const { id } = (await response.json()) as { id: number };
  return {
    id,
    async cleanup() {
      expect((await request.delete(`${API_BASE}/${kind}/${id}`)).ok()).toBeTruthy();
      if (filamentId !== undefined) expect((await request.delete(`${API_BASE}/filament/${filamentId}`)).ok()).toBeTruthy();
    },
  };
}

async function openInspector(page: Page, kind: EntityKind, id: number) {
  await openApp(page);
  await page.goto(`/?sel=${kind}:${id}`);
  await expect(page.locator(".insp")).toBeVisible();
}

async function holdFirstTwoWrites(page: Page, kind: EntityKind, id: number) {
  const firstReady = gate();
  const releaseFirst = gate();
  const secondReady = gate();
  const releaseSecond = gate();
  let writes = 0;
  await page.route(`**/api/v1/${kind}/${id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    writes++;
    if (writes === 1) {
      // Commit the first write but hold its response until newer typing is blurred.
      const response = await route.fetch();
      firstReady.release();
      await releaseFirst.wait;
      return route.fulfill({ response });
    }
    if (writes === 2) {
      // Keep the second write off the server while the first response reaches the UI.
      secondReady.release();
      await releaseSecond.wait;
    }
    return route.fallback();
  });
  return { firstReady, releaseFirst, secondReady, releaseSecond };
}

async function addField(
  request: APIRequestContext,
  key: string,
  name: string,
  fieldType: "float" | "float_range",
) {
  const response = await request.post(`${API_BASE}/field/filament/${key}`, {
    data: { name, order: 0, field_type: fieldType },
  });
  expect(response.ok()).toBeTruthy();
}

function finalPatch(page: Page, kind: EntityKind, id: number, matches: (body: Record<string, unknown>) => boolean) {
  return page.waitForResponse((response) => {
    const req = response.request();
    return (
      req.method() === "PATCH" &&
      response.url().endsWith(`/api/v1/${kind}/${id}`) &&
      matches(req.postDataJSON() as Record<string, unknown>)
    );
  });
}

for (const kind of ["filament", "spool", "vendor"] as const) {
  test(`${kind} text drafts survive blur, refocus and an older save`, async ({ page, request }) => {
    const entity = await createEntity(request, kind);
    let held: Awaited<ReturnType<typeof holdFirstTwoWrites>> | undefined;
    try {
      await openInspector(page, kind, entity.id);
      held = await holdFirstTwoWrites(page, kind, entity.id);
      const comment = page.locator(".insp").getByRole("textbox", { name: "Comment", exact: true });

      await comment.fill("draft first");
      await held.firstReady.wait;
      await comment.fill("draft first newer");
      await comment.blur();
      await page.waitForTimeout(650);
      held.releaseFirst.release();
      await held.secondReady.wait;
      await expect(page.locator(".toaster .success")).toBeVisible();
      await expect(comment).toHaveValue("draft first newer");

      await comment.focus();
      await comment.press("End");
      await comment.pressSequentially(" final");
      const final = "draft first newer final";
      const saved = finalPatch(page, kind, entity.id, (body) => body.comment === final);
      held.releaseSecond.release();
      expect((await saved).ok()).toBeTruthy();
      await comment.blur();
      expect((await (await request.get(`${API_BASE}/${kind}/${entity.id}`)).json()).comment).toBe(final);

      const external = "updated from another client";
      expect((await request.patch(`${API_BASE}/${kind}/${entity.id}`, { data: { comment: external } })).ok()).toBeTruthy();
      await expect(comment).toHaveValue(external);
    } finally {
      held?.releaseFirst.release();
      held?.releaseSecond.release();
      if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
      await entity.cleanup();
    }
  });
}

test("a numeric extra draft keeps comma formatting through delayed saves", async ({ page, request }) => {
  const key = `draft_float_${Date.now().toString(36)}`;
  const name = unique("Draft number");
  await addField(request, key, name, "float");
  let entity: Awaited<ReturnType<typeof createEntity>> | undefined;
  let held: Awaited<ReturnType<typeof holdFirstTwoWrites>> | undefined;
  try {
    entity = await createEntity(request, "filament", { [key]: "1" });
    await openInspector(page, "filament", entity.id);
    held = await holdFirstTwoWrites(page, "filament", entity.id);
    const number = page.locator(".insp").getByRole("textbox", { name, exact: true });

    await number.fill("1,2");
    await held.firstReady.wait;
    await number.fill("1,25");
    await number.blur();
    await page.waitForTimeout(650);
    held.releaseFirst.release();
    await held.secondReady.wait;
    await expect(page.locator(".toaster .success")).toBeVisible();
    await expect(number).toHaveValue("1,25");

    await number.focus();
    await number.press("End");
    await number.pressSequentially("6");
    const saved = finalPatch(page, "filament", entity.id, (body) => {
      const extra = body.extra as Record<string, string> | undefined;
      return extra?.[key] === "1.256";
    });
    held.releaseSecond.release();
    expect((await saved).ok()).toBeTruthy();
    await expect(number).toHaveValue("1,256");
    await number.blur();
    await expect(number).toHaveValue("1.256");

    const actual = await (await request.get(`${API_BASE}/filament/${entity.id}`)).json();
    expect(actual.extra[key]).toBe("1.256");
    const updated = await request.patch(`${API_BASE}/filament/${entity.id}`, { data: { extra: { [key]: "9.5" } } });
    expect(updated.ok()).toBeTruthy();
    await expect(number).toHaveValue("9.5");
  } finally {
    held?.releaseFirst.release();
    held?.releaseSecond.release();
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    if (entity) await entity.cleanup();
    expect((await request.delete(`${API_BASE}/field/filament/${key}`)).ok()).toBeTruthy();
  }
});

test("a built-in numeric draft survives an older save after blur", async ({ page, request }) => {
  const entity = await createEntity(request, "filament");
  let held: Awaited<ReturnType<typeof holdFirstTwoWrites>> | undefined;
  try {
    await openInspector(page, "filament", entity.id);
    held = await holdFirstTwoWrites(page, "filament", entity.id);
    const density = page.locator(".insp").getByRole("textbox", { name: "Density", exact: true });

    await density.fill("1,5");
    await density.blur();
    await held.firstReady.wait;
    await density.fill("1,75");
    await density.blur();
    await page.waitForTimeout(650);
    held.releaseFirst.release();
    await held.secondReady.wait;
    await expect(page.locator(".toaster .success")).toBeVisible();
    await expect(density).toHaveValue("1,75");

    await density.focus();
    await density.press("End");
    await density.pressSequentially("6");
    const saved = finalPatch(page, "filament", entity.id, (body) => body.density === 1.756);
    await density.blur();
    held.releaseSecond.release();
    expect((await saved).ok()).toBeTruthy();
    expect((await (await request.get(`${API_BASE}/filament/${entity.id}`)).json()).density).toBe(1.756);
    await expect(density).toHaveValue("1.756");
    expect((await request.patch(`${API_BASE}/filament/${entity.id}`, { data: { density: 2.5 } })).ok()).toBeTruthy();
    await expect(density).toHaveValue("2.5");
  } finally {
    held?.releaseFirst.release();
    held?.releaseSecond.release();
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    await entity.cleanup();
  }
});

test("editing one range bound preserves a newer draft in the other bound", async ({ page, request }) => {
  const key = `draft_range_${Date.now().toString(36)}`;
  const name = unique("Draft range");
  await addField(request, key, name, "float_range");
  let entity: Awaited<ReturnType<typeof createEntity>> | undefined;
  let held: Awaited<ReturnType<typeof holdFirstTwoWrites>> | undefined;
  try {
    entity = await createEntity(request, "filament", { [key]: "[1,10]" });
    await openInspector(page, "filament", entity.id);
    held = await holdFirstTwoWrites(page, "filament", entity.id);
    const low = page.locator(".insp").getByRole("textbox", { name: `${name} min`, exact: true });
    const high = page.locator(".insp").getByRole("textbox", { name: `${name} max`, exact: true });

    await low.fill("2,5");
    await held.firstReady.wait;
    await high.fill("20,5");
    await high.blur();
    await page.waitForTimeout(650);
    held.releaseFirst.release();
    await held.secondReady.wait;
    await expect(page.locator(".toaster .success")).toBeVisible();
    await expect(low).toHaveValue("2,5");
    await expect(high).toHaveValue("20,5");

    await low.fill("3,5");
    const saved = finalPatch(page, "filament", entity.id, (body) => {
      const extra = body.extra as Record<string, string> | undefined;
      return extra?.[key] === "[3.5,20.5]";
    });
    held.releaseSecond.release();
    expect((await saved).ok()).toBeTruthy();
    await expect(low).toHaveValue("3,5");
    await low.blur();
    await expect(low).toHaveValue("3.5");
    await expect(high).toHaveValue("20.5");
    const actual = await (await request.get(`${API_BASE}/filament/${entity.id}`)).json();
    expect(JSON.parse(actual.extra[key])).toEqual([3.5, 20.5]);
  } finally {
    held?.releaseFirst.release();
    held?.releaseSecond.release();
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    if (entity) await entity.cleanup();
    expect((await request.delete(`${API_BASE}/field/filament/${key}`)).ok()).toBeTruthy();
  }
});

test("a failed GTIN save remains visible and the same valid value can be retried", async ({ page, request }) => {
  const entity = await createEntity(request, "filament");
  try {
    await openInspector(page, "filament", entity.id);
    let failed = false;
    await page.route(`**/api/v1/filament/${entity.id}`, async (route) => {
      if (route.request().method() === "PATCH" && !failed) {
        failed = true;
        return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      }
      return route.fallback();
    });
    const gtin = page.locator(".insp").getByRole("textbox", { name: "Barcode (GTIN)", exact: true });
    await gtin.fill("4006381333931");
    await gtin.blur();
    await expect(page.locator(".toaster .error")).toContainText("503");
    await expect(gtin).toHaveValue("4006381333931");
    expect((await (await request.get(`${API_BASE}/filament/${entity.id}`)).json()).gtin ?? null).toBeNull();

    await gtin.fill("400638133393");
    await expect(gtin).toHaveAttribute("aria-invalid", "true");
    const saved = finalPatch(page, "filament", entity.id, (body) => body.gtin === "04006381333931");
    await gtin.fill("4006381333931");
    await gtin.blur();
    expect((await saved).ok()).toBeTruthy();
    expect((await (await request.get(`${API_BASE}/filament/${entity.id}`)).json()).gtin).toBe("04006381333931");
  } finally {
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    await entity.cleanup();
  }
});

test("a failed numeric extra save keeps its draft until a retry succeeds", async ({ page, request }) => {
  const key = `draft_failure_${Date.now().toString(36)}`;
  const name = unique("Draft failure");
  await addField(request, key, name, "float");
  let entity: Awaited<ReturnType<typeof createEntity>> | undefined;
  try {
    entity = await createEntity(request, "filament", { [key]: "1" });
    await openInspector(page, "filament", entity.id);
    let failed = false;
    await page.route(`**/api/v1/filament/${entity.id}`, async (route) => {
      if (route.request().method() === "PATCH" && !failed) {
        failed = true;
        return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      }
      return route.fallback();
    });
    const number = page.locator(".insp").getByRole("textbox", { name, exact: true });
    await number.fill("1,5");
    await number.blur();
    await expect(page.locator(".toaster .error")).toContainText("503");
    expect((await (await request.get(`${API_BASE}/filament/${entity.id}`)).json()).extra[key]).toBe("1");

    expect(
      (
        await request.patch(`${API_BASE}/filament/${entity.id}`, {
          data: { extra: { [key]: "7.5" }, comment: "external update arrived" },
        })
      ).ok(),
    ).toBeTruthy();
    await expect(page.locator(".insp").getByRole("textbox", { name: "Comment", exact: true })).toHaveValue(
      "external update arrived",
    );
    await expect(number).toHaveValue("1,5");
    const saved = finalPatch(page, "filament", entity.id, (body) => {
      const extra = body.extra as Record<string, string> | undefined;
      return extra?.[key] === "1.5";
    });
    await number.fill("1,50");
    await number.blur();
    expect((await saved).ok()).toBeTruthy();
    await expect(number).toHaveValue("1.5");

    expect(
      (await request.patch(`${API_BASE}/filament/${entity.id}`, { data: { extra: { [key]: "9.5" } } })).ok(),
    ).toBeTruthy();
    await expect(number).toHaveValue("9.5");
  } finally {
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    if (entity) await entity.cleanup();
    expect((await request.delete(`${API_BASE}/field/filament/${key}`)).ok()).toBeTruthy();
  }
});

test("a failed built-in numeric save remains editable until retried", async ({ page, request }) => {
  const entity = await createEntity(request, "filament");
  try {
    await openInspector(page, "filament", entity.id);
    let failed = false;
    await page.route(`**/api/v1/filament/${entity.id}`, async (route) => {
      if (route.request().method() === "PATCH" && !failed) {
        failed = true;
        return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      }
      return route.fallback();
    });
    const density = page.locator(".insp").getByRole("textbox", { name: "Density", exact: true });
    await density.fill("1,5");
    await density.blur();
    await expect(page.locator(".toaster .error")).toContainText("503");
    expect((await (await request.get(`${API_BASE}/filament/${entity.id}`)).json()).density).toBe(1.24);

    expect(
      (
        await request.patch(`${API_BASE}/filament/${entity.id}`, {
          data: { density: 2, comment: "external update arrived" },
        })
      ).ok(),
    ).toBeTruthy();
    await expect(page.locator(".insp").getByRole("textbox", { name: "Comment", exact: true })).toHaveValue(
      "external update arrived",
    );
    await expect(density).toHaveValue("1,5");
    const saved = finalPatch(page, "filament", entity.id, (body) => body.density === 1.6);
    await density.fill("1,6");
    await density.blur();
    expect((await saved).ok()).toBeTruthy();
    await expect(density).toHaveValue("1.6");

    expect((await request.patch(`${API_BASE}/filament/${entity.id}`, { data: { density: 2.5 } })).ok()).toBeTruthy();
    await expect(density).toHaveValue("2.5");
  } finally {
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    await entity.cleanup();
  }
});

for (const { kind, label, property, first, newer } of [
  { kind: "spool", label: "Location", property: "location", first: "First shelf", newer: "Newer shelf" },
  { kind: "filament", label: "Material", property: "material", first: "First material", newer: "Newer material" },
] as const) {
  test(`${label} combobox keeps a newer draft through a delayed save`, async ({ page, request }) => {
    const entity = await createEntity(request, kind);
    let held: Awaited<ReturnType<typeof holdFirstTwoWrites>> | undefined;
    try {
      await openInspector(page, kind, entity.id);
      held = await holdFirstTwoWrites(page, kind, entity.id);
      const input = page.locator(".insp").getByRole("combobox", { name: label, exact: true });

      await input.fill(first);
      await held.firstReady.wait;
      await input.fill(newer);
      await input.blur();
      await page.waitForTimeout(650);
      held.releaseFirst.release();
      await held.secondReady.wait;
      await expect(input).toHaveValue(newer);
      const saved = finalPatch(page, kind, entity.id, (body) => body[property] === newer);
      held.releaseSecond.release();
      expect((await saved).ok()).toBeTruthy();
      expect((await (await request.get(`${API_BASE}/${kind}/${entity.id}`)).json())[property]).toBe(newer);
      await expect(input).toHaveValue(newer);
    } finally {
      held?.releaseFirst.release();
      held?.releaseSecond.release();
      if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
      await entity.cleanup();
    }
  });

  test(`${label} combobox retains a failed draft until retry succeeds`, async ({ page, request }) => {
    const entity = await createEntity(request, kind);
    try {
      await openInspector(page, kind, entity.id);
      let failed = false;
      await page.route(`**/api/v1/${kind}/${entity.id}`, async (route) => {
        if (route.request().method() === "PATCH" && !failed) {
          failed = true;
          return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
        }
        return route.fallback();
      });
      const input = page.locator(".insp").getByRole("combobox", { name: label, exact: true });
      await input.fill(first);
      await input.blur();
      await expect(page.locator(".toaster .error")).toContainText("503");

      expect(
        (
          await request.patch(`${API_BASE}/${kind}/${entity.id}`, {
            data: { [property]: "Remote value", comment: "external update arrived" },
          })
        ).ok(),
      ).toBeTruthy();
      await expect(page.locator(".insp").getByRole("textbox", { name: "Comment", exact: true })).toHaveValue(
        "external update arrived",
      );
      await expect(input).toHaveValue(first);

      await input.fill(newer);
      const saved = finalPatch(page, kind, entity.id, (body) => body[property] === first);
      await input.fill(first);
      await input.blur();
      expect((await saved).ok()).toBeTruthy();
      expect((await (await request.get(`${API_BASE}/${kind}/${entity.id}`)).json())[property]).toBe(first);
      expect(
        (await request.patch(`${API_BASE}/${kind}/${entity.id}`, { data: { [property]: "After retry" } })).ok(),
      ).toBeTruthy();
      await expect(input).toHaveValue("After retry");
    } finally {
      if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
      await entity.cleanup();
    }
  });
}

test("a failed archive is reported, rolled back, and can be retried", async ({ page, request }) => {
  const entity = await createEntity(request, "spool");
  const started = gate();
  const release = gate();
  try {
    await openInspector(page, "spool", entity.id);
    let failed = false;
    await page.route(`**/api/v1/spool/${entity.id}`, async (route) => {
      if (route.request().method() === "PATCH" && !failed) {
        failed = true;
        started.release();
        await release.wait;
        return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      }
      return route.fallback();
    });

    await page.locator(".insp").getByRole("button", { name: "Archive", exact: true }).click();
    await started.wait;
    await expect(page.locator(".insp").getByRole("button", { name: /^(Unarchive|Archive)$/ })).toBeDisabled();
    release.release();
    await expect(page.locator(".toaster .error")).toContainText("503");
    const archive = page.locator(".insp").getByRole("button", { name: "Archive", exact: true });
    await expect(archive).toBeEnabled();
    expect((await (await request.get(`${API_BASE}/spool/${entity.id}`)).json()).archived).toBe(false);

    await archive.click();
    await expect(page.locator(".insp").getByRole("button", { name: "Unarchive", exact: true })).toBeEnabled();
    expect((await (await request.get(`${API_BASE}/spool/${entity.id}`)).json()).archived).toBe(true);
  } finally {
    release.release();
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    await entity.cleanup();
  }
});
