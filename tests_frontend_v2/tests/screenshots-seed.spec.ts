import { expect, test } from "@playwright/test";
import { seedScreenshots, type SeedPrefixes, type SeedRequest } from "./screenshots-seed";

type Resource = "vendor" | "filament" | "spool";
type Row = { id: number; [key: string]: unknown };

class FakeResponse {
  constructor(private readonly data: unknown) {}
  ok() { return true; }
  async text() { return JSON.stringify(this.data); }
  async json() { return this.data; }
}

class FakeRequest implements SeedRequest {
  readonly rows: Record<Resource, Row[]> = { vendor: [], filament: [], spool: [] };
  private readonly sequences: SeedPrefixes = { vendor: 0, filament: 0, spool: 0 };
  private attempts = 0;
  writes = 0;

  constructor(private readonly failAfter: number, private readonly rollbackAt = 0) {}

  reconcileSequences = async (prefixes: SeedPrefixes) => {
    Object.assign(this.sequences, prefixes);
  };

  private resource(path: string): Resource {
    const name = path.split("?")[0].split("/").pop();
    if (name === "vendor" || name === "filament" || name === "spool") return name;
    throw new Error(`Unexpected request: ${path}`);
  }

  async get(path: string) {
    return new FakeResponse(this.rows[this.resource(path)]);
  }

  async post(path: string, { data }: { data: object }) {
    const resource = this.resource(path);
    const id = ++this.sequences[resource];
    this.attempts++;
    // PostgreSQL sequences advance even if the insert transaction rolls back.
    if (this.attempts === this.rollbackAt) throw new Error("insert rolled back");
    const row: Row = { id, extra: {}, ...data };
    if (resource === "filament") {
      const vendor = this.rows.vendor.find(({ id }) => id === row.vendor_id)!;
      row.vendor = { id: row.vendor_id };
      row.spool_weight = vendor.empty_spool_weight;
      row.tags = [];
      delete row.vendor_id;
    } else if (resource === "spool") {
      const filament = this.rows.filament.find(({ id }) => id === row.filament_id)!;
      row.filament = { id: row.filament_id };
      row.initial_weight = filament.weight;
      row.remaining_weight = Number(filament.weight) - Number(row.used_weight);
      row.spool_weight = filament.spool_weight;
      row.archived = false;
      row.tags = [];
      delete row.filament_id;
    }
    this.rows[resource].push(row);
    this.writes++;
    // The server committed the row, but the worker lost the response.
    if (this.writes === this.failAfter) throw new Error("connection dropped");
    return new FakeResponse(row);
  }
}

test("screenshot seeding resumes after every partially committed write", async () => {
  for (let failAfter = 1; failAfter <= 13; failAfter++) {
    const request = new FakeRequest(failAfter);
    await expect(seedScreenshots(request)).rejects.toThrow("connection dropped");
    await seedScreenshots(request);
    expect(request.rows.vendor.map(({ id }) => id)).toEqual([1, 2]);
    expect(request.rows.filament.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5]);
    expect(request.rows.spool.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6]);
    const snapshot = structuredClone(request.rows);
    await seedScreenshots(request);
    expect(request.rows).toEqual(snapshot);
    expect(request.writes).toBe(13);
  }
});

test("screenshot seeding resumes after every rolled-back insert", async () => {
  for (let rollbackAt = 1; rollbackAt <= 13; rollbackAt++) {
    const request = new FakeRequest(0, rollbackAt);
    await expect(seedScreenshots(request, request.reconcileSequences)).rejects.toThrow("insert rolled back");
    await seedScreenshots(request, request.reconcileSequences);
    expect(request.rows.vendor.map(({ id }) => id)).toEqual([1, 2]);
    expect(request.rows.filament.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5]);
    expect(request.rows.spool.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6]);
    const snapshot = structuredClone(request.rows);
    await seedScreenshots(request, request.reconcileSequences);
    expect(request.rows).toEqual(snapshot);
    expect(request.writes).toBe(13);
  }
});

test("screenshot seeding refuses unrelated data before making any writes", async () => {
  const request = new FakeRequest(0);
  request.rows.spool.push({ id: 99 });
  let reconciled = false;
  await expect(seedScreenshots(request, async () => { reconciled = true; })).rejects.toThrow(
    "screenshots require a dedicated database",
  );
  expect(reconciled).toBe(false);
  expect(request.writes).toBe(0);
});

test("screenshot seeding stops before writing if sequence reconciliation fails", async () => {
  const request = new FakeRequest(0);
  await expect(seedScreenshots(request, async () => { throw new Error("sequence repair failed"); })).rejects.toThrow(
    "sequence repair failed",
  );
  expect(request.writes).toBe(0);
});

test("screenshot seeding refuses a gap without inserting replacement rows", async () => {
  const request = new FakeRequest(0);
  await seedScreenshots(request);
  request.rows.spool.splice(1, 1);
  const snapshot = structuredClone(request.rows);

  await expect(seedScreenshots(request)).rejects.toThrow("screenshot seed is not a valid prefix");
  expect(request.rows).toEqual(snapshot);
  expect(request.writes).toBe(13);
});

test("screenshot seeding refuses rows after an incomplete earlier resource", async () => {
  const request = new FakeRequest(0);
  await seedScreenshots(request);
  request.rows.vendor.pop();
  const snapshot = structuredClone(request.rows);

  await expect(seedScreenshots(request)).rejects.toThrow("Unexpected filament rows after an incomplete screenshot seed");
  expect(request.rows).toEqual(snapshot);
  expect(request.writes).toBe(13);
});

test("screenshot seeding refuses modified fixtures before inserting missing rows", async () => {
  const mutations: Array<[string, (request: FakeRequest) => void]> = [
    ["extra fields", (request) => { request.rows.vendor[0].extra = { note: "changed" }; }],
    ["unexpected optional fields", (request) => { request.rows.filament[0].gtin = "123"; }],
    ["archived spool", (request) => { request.rows.spool[0].archived = true; }],
    ["changed initial weight", (request) => { request.rows.spool[0].initial_weight = 999; }],
  ];
  for (const [name, mutate] of mutations) {
    await test.step(name, async () => {
      const request = new FakeRequest(0);
      await seedScreenshots(request);
      request.rows.spool.pop();
      mutate(request);
      const snapshot = structuredClone(request.rows);

      await expect(seedScreenshots(request)).rejects.toThrow();
      expect(request.rows).toEqual(snapshot);
      expect(request.writes).toBe(13);
    });
  }
});
