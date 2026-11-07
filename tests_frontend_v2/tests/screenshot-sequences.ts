import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SeedPrefixes } from "./screenshots-seed";

const execFileAsync = promisify(execFile);
const composeFile = fileURLToPath(new URL("../docker-compose.yml", import.meta.url));

export function sequenceResetSql(prefixes: SeedPrefixes): string {
  const resources = ["vendor", "filament", "spool"] as const;
  for (const resource of resources) {
    if (!Number.isSafeInteger(prefixes[resource]) || prefixes[resource] < 0) {
      throw new Error(`Invalid screenshot seed prefix for ${resource}`);
    }
  }
  const checks = resources.map((resource) => `
    IF (SELECT count(*) FROM ${resource}) <> ${prefixes[resource]}
       OR EXISTS (SELECT 1 FROM ${resource} WHERE id < 1 OR id > ${prefixes[resource]}) THEN
      RAISE EXCEPTION 'Unexpected ${resource} rows in screenshot test database';
    END IF;
    IF pg_get_serial_sequence('${resource}', 'id') IS NULL THEN
      RAISE EXCEPTION 'No ID sequence for ${resource}';
    END IF;`).join("");
  const resets = resources.map((resource) => `
    PERFORM setval(pg_get_serial_sequence('${resource}', 'id'),
                   GREATEST(${prefixes[resource]}, 1), ${prefixes[resource] > 0});`).join("");
  return `
    BEGIN;
    LOCK TABLE vendor, filament, spool IN SHARE ROW EXCLUSIVE MODE;
    DO $seed$
    BEGIN
      ${checks}
      ${resets}
    END
    $seed$;
    COMMIT;
  `;
}

/** Reconcile only the explicitly selected, disposable Compose test database. */
export async function reconcileComposeSequences(prefixes: SeedPrefixes): Promise<void> {
  await execFileAsync(
    process.env.SPOOLMAN_CONTAINER_ENGINE ?? "docker",
    [
      "compose", "-f", composeFile, "exec", "-T", "db",
      "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "spoolman", "-d", "spoolman",
      "-c", sequenceResetSql(prefixes),
    ],
    { timeout: 30_000 },
  );
}
