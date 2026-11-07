import { expect, type APIRequestContext } from "@playwright/test";

const API_BASE = process.env.SPOOLMAN_API_URL ?? `${process.env.SPOOLMAN_BASE_URL ?? "http://localhost:8001"}/api/v1`;

/** Remove only layout entries owned by a test, retaining the current unrelated settings. */
export async function removeTestLayoutEntries(request: APIRequestContext, locations: string[], fields: string[] = []) {
  const response = await request.get(`${API_BASE}/setting/`);
  expect(response.ok()).toBeTruthy();
  const settings = await response.json();
  const groups = JSON.parse(settings.dashboard_groups.value) as Record<string, string[]>;
  const orders = JSON.parse(settings.dashboard_spoolorders.value) as Record<string, Record<string, number[]>>;
  const removed = new Set(locations);
  if (groups.location) groups.location = groups.location.filter((group) => !removed.has(group));
  if (orders.location) for (const location of locations) delete orders.location[location];
  for (const field of fields) {
    delete groups[field];
    delete orders[field];
  }
  for (const [key, value] of [
    ["dashboard_groups", groups],
    ["dashboard_spoolorders", orders],
  ] as const) {
    const saved = await request.post(`${API_BASE}/setting/${key}`, {
      headers: { "content-type": "application/json" },
      data: JSON.stringify(JSON.stringify(value)),
    });
    expect(saved.ok()).toBeTruthy();
  }
}
