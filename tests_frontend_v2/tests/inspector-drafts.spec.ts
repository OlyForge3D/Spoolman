import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { openApp, unique } from "./helpers";

const API_BASE =
  process.env.SPOOLMAN_API_URL ??
  `${process.env.SPOOLMAN_BASE_URL ?? "http://localhost:8001"}/api/v1`;

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release };
}

async function createFilament(
  request: APIRequestContext,
  extra: Record<string, string> = {},
) {
  const response = await request.post(`${API_BASE}/filament`, {
    data: {
      name: unique("Draft filament"),
      material: "PLA",
      density: 1.24,
      diameter: 1.75,
      weight: 1000,
      comment: "original",
      extra,
    },
  });
  expect(response.ok()).toBeTruthy();
  const { id } = (await response.json()) as { id: number };
  return {
    id,
    async cleanup() {
      expect(
        (await request.delete(`${API_BASE}/filament/${id}`)).ok(),
      ).toBeTruthy();
    },
  };
}

async function holdFirstTwoWrites(page: Page, id: number) {
  const firstReady = gate();
  const releaseFirst = gate();
  const secondReady = gate();
  const releaseSecond = gate();
  let writes = 0;
  await page.route(`**/api/v1/filament/${id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    writes++;
    if (writes === 1) {
      const response = await route.fetch();
      firstReady.release();
      await releaseFirst.wait;
      return route.fulfill({ response });
    }
    if (writes === 2) {
      secondReady.release();
      await releaseSecond.wait;
    }
    return route.fallback();
  });
  return { firstReady, releaseFirst, secondReady, releaseSecond };
}

async function openInspector(page: Page, id: number) {
  await openApp(page);
  await page.goto(`/?sel=filament:${id}`);
  await expect(page.locator(".insp")).toBeVisible();
}

function finalPatch(
  page: Page,
  id: number,
  matches: (body: Record<string, unknown>) => boolean,
) {
  return page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === "PATCH" &&
      response.url().endsWith(`/api/v1/filament/${id}`) &&
      matches(request.postDataJSON() as Record<string, unknown>)
    );
  });
}

test("text draft survives an older response after blur and accepts later updates", async ({
  page,
  request,
}) => {
  const filament = await createFilament(request);
  let held: Awaited<ReturnType<typeof holdFirstTwoWrites>> | undefined;
  try {
    await openInspector(page, filament.id);
    held = await holdFirstTwoWrites(page, filament.id);
    const comment = page
      .locator(".insp")
      .getByRole("textbox", { name: "Comment", exact: true });

    await comment.fill("draft first");
    await held.firstReady.wait;
    await comment.fill("draft first newer");
    await comment.blur();
    await page.waitForTimeout(650);
    const secondStartedEarly = await Promise.race([
      held.secondReady.wait.then(() => true),
      page.waitForTimeout(100).then(() => false),
    ]);
    expect(secondStartedEarly).toBe(false);
    held.releaseFirst.release();
    await held.secondReady.wait;
    await expect(comment).toHaveValue("draft first newer");

    const final = "draft first newer final";
    await comment.focus();
    await comment.press("End");
    await comment.pressSequentially(" final");
    const saved = finalPatch(
      page,
      filament.id,
      (body) => body.comment === final,
    );
    held.releaseSecond.release();
    expect((await saved).ok()).toBeTruthy();
    await comment.blur();
    await expect(comment).toHaveValue(final);

    const external = "updated from another client";
    expect(
      (
        await request.patch(`${API_BASE}/filament/${filament.id}`, {
          data: { comment: external },
        })
      ).ok(),
    ).toBeTruthy();
    await expect(comment).toHaveValue(external);
  } finally {
    held?.releaseFirst.release();
    held?.releaseSecond.release();
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    await filament.cleanup();
  }
});

test("numeric extra-field formatting survives delayed saves and later updates", async ({
  page,
  request,
}) => {
  const key = `draft_float_${Date.now().toString(36)}`;
  const name = unique("Draft number");
  const field = await request.post(`${API_BASE}/field/filament/${key}`, {
    data: { name, order: 0, field_type: "float" },
  });
  expect(field.ok()).toBeTruthy();
  let filament: Awaited<ReturnType<typeof createFilament>> | undefined;
  let held: Awaited<ReturnType<typeof holdFirstTwoWrites>> | undefined;
  try {
    filament = await createFilament(request, { [key]: "1" });
    await openInspector(page, filament.id);
    held = await holdFirstTwoWrites(page, filament.id);
    const number = page
      .locator(".insp")
      .getByRole("textbox", { name, exact: true });

    await number.fill("1,2");
    await held.firstReady.wait;
    await number.fill("1,25");
    await number.blur();
    await page.waitForTimeout(650);
    const secondStartedEarly = await Promise.race([
      held.secondReady.wait.then(() => true),
      page.waitForTimeout(100).then(() => false),
    ]);
    expect(secondStartedEarly).toBe(false);
    held.releaseFirst.release();
    await held.secondReady.wait;
    await expect(number).toHaveValue("1,25");

    await number.focus();
    await number.press("End");
    await number.pressSequentially("6");
    const saved = finalPatch(page, filament.id, (body) => {
      const extra = body.extra as Record<string, string> | undefined;
      return extra?.[key] === "1.256";
    });
    held.releaseSecond.release();
    expect((await saved).ok()).toBeTruthy();
    await expect(number).toHaveValue("1,256");
    await number.blur();
    await expect(number).toHaveValue("1.256");

    expect(
      (
        await request.patch(`${API_BASE}/filament/${filament.id}`, {
          data: { extra: { [key]: "9.5" } },
        })
      ).ok(),
    ).toBeTruthy();
    await expect(number).toHaveValue("9.5");
  } finally {
    held?.releaseFirst.release();
    held?.releaseSecond.release();
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    if (filament) await filament.cleanup();
    expect(
      (await request.delete(`${API_BASE}/field/filament/${key}`)).ok(),
    ).toBeTruthy();
  }
});
