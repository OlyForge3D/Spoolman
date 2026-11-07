import { inventory } from '$lib/stores/inventory.svelte';
import type { Spool } from '$lib/types';
import { mapFilament, mapVendor } from './map';

/** Do not let an ordinary read overwrite a quarantined spool or its relations. */
export function cacheSpoolRead(raw: Record<string, unknown>, spool: Spool): Spool {
	if (!inventory.considerSpool(spool)) return inventory.spoolById(spool.id) ?? spool;
	const filament = raw.filament as Record<string, unknown> | undefined;
	if (filament) {
		inventory.upsertFilament(mapFilament(filament));
		const vendor = filament.vendor as Record<string, unknown> | undefined;
		if (vendor) inventory.upsertVendor(mapVendor(vendor));
	}
	inventory.upsertSpool(spool);
	return spool;
}
