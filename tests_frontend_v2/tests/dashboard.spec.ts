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

test("a failed drag reports the error and restores the server's spool location", async ({ page, request }) => {
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

  try {
    await page.route(`**/api/v1/spool/${ids[0]}`, async (route) => {
      if (route.request().method() === "PATCH") {
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
    await expect(source.locator(".chip").filter({ hasText: `#${ids[0]}` })).toBeVisible();
    await expect(target.locator(".chip").filter({ hasText: `#${ids[0]}` })).toHaveCount(0);
    expect((await (await request.get(`${API_BASE}/spool/${ids[0]}`)).json()).location).toBe(firstLocation);
  } finally {
    if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
    for (const id of ids) await request.delete(`${API_BASE}/spool/${id}`);
    await request.delete(`${API_BASE}/filament/${filamentId}`);
  }
});
