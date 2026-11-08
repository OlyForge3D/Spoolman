import { expect, test } from "@playwright/test";
import { sequenceResetSql } from "./screenshot-sequences";
import type { SeedPrefixes } from "./screenshots-seed";

test("sequence SQL rejects invalid prefixes for every resource", () => {
  for (const resource of ["vendor", "filament", "spool"] as const) {
    for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const prefixes: SeedPrefixes = { vendor: 0, filament: 0, spool: 0 };
      prefixes[resource] = invalid;
      expect(() => sequenceResetSql(prefixes)).toThrow(`Invalid screenshot seed prefix for ${resource}`);
    }
  }
});

test("sequence SQL resets empty and populated prefixes for each resource", () => {
  for (const resource of ["vendor", "filament", "spool"] as const) {
    for (const prefix of [0, 3]) {
      const prefixes: SeedPrefixes = { vendor: 0, filament: 0, spool: 0 };
      prefixes[resource] = prefix;
      const sql = sequenceResetSql(prefixes);
      expect(sql).toContain(
        `PERFORM setval(pg_get_serial_sequence('${resource}', 'id'),\n` +
        `                   GREATEST(${prefix}, 1), ${prefix > 0});`,
      );
      expect(sql).toContain(`IF (SELECT count(*) FROM ${resource}) <> ${prefix}`);
      expect(sql).toContain(`WHERE id < 1 OR id > ${prefix}`);
    }
  }
});
