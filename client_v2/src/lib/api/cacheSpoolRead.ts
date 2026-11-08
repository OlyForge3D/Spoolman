import { inventory } from '$lib/stores/inventory.svelte';
import type { Spool } from '$lib/types';
import { mapFilament, mapVendor } from './map';

export function cacheSpoolRelations(raw: Record<string, unknown>, revision: number): void {
	const filament = raw.filament as Record<string, unknown> | undefined;
	if (filament) {
		inventory.cacheFilamentRead(mapFilament(filament), revision);
		const vendor = filament.vendor as Record<string, unknown> | undefined;
		if (vendor) inventory.cacheVendorRead(mapVendor(vendor), revision);
	}
}

/** Do not let an ordinary read overwrite a quarantined spool or its relations. */
export function cacheSpoolRead(raw: Record<string, unknown>, spool: Spool, revision: number): Spool {
	if (!inventory.considerSpool(spool)) return inventory.spoolById(spool.id) ?? spool;
	cacheSpoolRelations(raw, revision);
	inventory.upsertSpool(spool);
	return spool;
}
