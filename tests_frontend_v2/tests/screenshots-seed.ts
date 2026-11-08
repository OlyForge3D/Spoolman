import { expect } from "@playwright/test";

interface SeedResponse {
  ok(): boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface SeedRequest {
  get(path: string): Promise<SeedResponse>;
  post(path: string, options: { data: object }): Promise<SeedResponse>;
}

type Resource = "vendor" | "filament" | "spool";
type RecordWithId = { id: number; [key: string]: unknown };
export type SeedPrefixes = Record<Resource, number>;

// Fixed timestamps so "last used" style fields never depend on when CI ran.
const USED_AT = "2025-01-15T12:00:00Z";

const vendors = [
  { name: "Prusament", empty_spool_weight: 193 },
  { name: "Polymaker", empty_spool_weight: 140 },
];
const filaments = [
  { vendor_id: 1, name: "Galaxy Black", material: "PLA", color_hex: "1A1A1A", density: 1.24 },
  { vendor_id: 1, name: "Jet Orange", material: "PETG", color_hex: "F26722", density: 1.27 },
  { vendor_id: 2, name: "PolyTerra Sakura Pink", material: "PLA", color_hex: "F4A7B9", density: 1.24 },
  { vendor_id: 2, name: "PolyLite Teal", material: "ABS", color_hex: "008080", density: 1.04 },
  {
    vendor_id: 2,
    name: "Dual Silk Sunrise",
    material: "PLA",
    multi_color_hexes: "FFD700,C0392B",
    multi_color_direction: "coaxial",
    density: 1.24,
  },
].map((filament) => ({ diameter: 1.75, weight: 1000, ...filament }));
const spools = [
  { filament_id: 1, used_weight: 0, location: "Shelf A" },
  { filament_id: 1, used_weight: 640, lot_nr: "LOT-2026-0915-A7", location: "Printer 1", first_used: USED_AT, last_used: USED_AT },
  { filament_id: 2, used_weight: 120, location: "Shelf A", first_used: USED_AT, last_used: USED_AT },
  { filament_id: 3, used_weight: 910, location: "Dry box", first_used: USED_AT, last_used: USED_AT },
  { filament_id: 4, used_weight: 0, location: "Shelf B" },
  { filament_id: 5, used_weight: 300, location: "Printer 2", first_used: USED_AT, last_used: USED_AT },
];

const plans = [
  { resource: "vendor" as const, data: vendors, expected: vendors },
  {
    resource: "filament" as const,
    data: filaments,
    expected: filaments.map(({ vendor_id, ...filament }) => ({
      ...filament,
      vendor: { id: vendor_id },
      spool_weight: vendors[vendor_id - 1].empty_spool_weight,
      tags: [],
    })),
  },
  {
    resource: "spool" as const,
    data: spools,
    expected: spools.map(({ filament_id, ...spool }) => ({
      ...spool,
      filament: { id: filament_id },
      initial_weight: 1000,
      remaining_weight: 1000 - spool.used_weight,
      spool_weight: vendors[filaments[filament_id - 1].vendor_id - 1].empty_spool_weight,
      archived: false,
      tags: [],
    })),
  },
];

const optionalFields: Record<Resource, string[]> = {
  vendor: ["comment", "external_id"],
  filament: [
    "price", "article_number", "gtin", "comment", "settings_extruder_temp", "settings_bed_temp",
    "color_hex", "multi_color_hexes", "multi_color_direction", "external_id",
  ],
  spool: ["first_used", "last_used", "price", "lot_nr", "comment"],
};

function expectFixture(resource: Resource, row: RecordWithId, expected: Record<string, unknown>): void {
  const context = `${resource} ${row.id}`;
  expect(row, `Existing ${context} does not match the screenshot seed`).toMatchObject(expected);
  expect(row.extra, `Unexpected extra fields on ${context}`).toEqual({});
  for (const field of optionalFields[resource]) {
    expect(row[field] ?? null, `Unexpected ${field} on ${context}`).toEqual(expected[field] ?? null);
  }
}

async function list(request: SeedRequest, resource: Resource): Promise<RecordWithId[]> {
  const suffix = resource === "spool" ? "?allow_archived=true" : "";
  const response = await request.get(`/api/v1/${resource}${suffix}`);
  expect(response.ok(), `GET ${resource}: ${await response.text()}`).toBeTruthy();
  const result = await response.json();
  if (!Array.isArray(result)) throw new Error(`GET ${resource} did not return a list`);
  return result as RecordWithId[];
}

/**
 * Resume a partial seed without inserting duplicates or changing the fixed IDs.
 * Validate all existing rows first so an unrelated database is never reset or
 * silently mixed into the screenshot data.
 */
export async function seedScreenshots(
  request: SeedRequest,
  reconcileSequences?: (prefixes: SeedPrefixes) => Promise<void>,
): Promise<void> {
  const existing = await Promise.all(plans.map(({ resource }) => list(request, resource)));
  for (const [planIndex, { resource, expected }] of plans.entries()) {
    const seen = new Set<number>();
    for (const row of existing[planIndex]) {
      if (!Number.isInteger(row.id) || row.id < 1 || row.id > expected.length || seen.has(row.id)) {
        throw new Error(`Unexpected ${resource} ID ${row.id}; screenshots require a dedicated database`);
      }
      seen.add(row.id);
      expectFixture(resource, row, expected[row.id - 1]);
    }
    for (let id = 1; id <= seen.size; id++) {
      if (!seen.has(id)) throw new Error(`Missing ${resource} ID ${id}; screenshot seed is not a valid prefix`);
    }
    if (seen.size > 0 && planIndex > 0 && existing[planIndex - 1].length !== plans[planIndex - 1].expected.length) {
      throw new Error(`Unexpected ${resource} rows after an incomplete screenshot seed`);
    }
  }

  if (reconcileSequences) {
    await reconcileSequences({
      vendor: existing[0].length,
      filament: existing[1].length,
      spool: existing[2].length,
    });
  }

  for (const [planIndex, { resource, data, expected }] of plans.entries()) {
    const ids = new Set(existing[planIndex].map(({ id }) => id));
    for (const [index, row] of data.entries()) {
      const id = index + 1;
      if (ids.has(id)) continue;
      const response = await request.post(`/api/v1/${resource}`, { data: row });
      expect(response.ok(), `POST ${resource}: ${await response.text()}`).toBeTruthy();
      const created = (await response.json()) as RecordWithId;
      expect(created.id, `Unexpected ${resource} ID after seeding; reset the dedicated test database`).toBe(id);
      expectFixture(resource, created, expected[index]);
    }
  }
}
