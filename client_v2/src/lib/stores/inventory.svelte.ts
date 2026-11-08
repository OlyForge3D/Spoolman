import type { Filament, Spool, Vendor } from '$lib/types';
import type { LiveEvent } from '$lib/api/live';
import type { GroupField } from '$lib/api/types';
import { mapFilament, mapSpool, mapVendor } from '$lib/api/map';

// Reactive, normalized client cache. Populated by HTTP responses (the data
// source upserts every entity it fetches) and kept live by liveSync applying
// WebSocket events. Every detail view reads it reactively, so a change from any
// source updates the UI. It is NOT the source of truth for the paginated list —
// that fetches server-paged data directly.

class Inventory {
	vendors = $state<Vendor[]>([]);
	filaments = $state<Filament[]>([]);
	spools = $state<Spool[]>([]);
	spoolRenameRevision = $state(0);
	spoolRenamesInFlight = $state(0);
	private uncertainSpools = $state<
		Record<number, { field: GroupField; revision: number; pendingValue?: string }[]>
	>({});
	private nextUncertainty = 0;
	private readonly spoolUpsertObservers = new Set<(spool: Spool) => void>();
	private readonly spoolUncertaintyObservers = new Set<(id: number) => void>();
	private readonly relationDraftObservers = new Set<() => void>();
	private readonly relationRevisions = new Map<string, number>();
	private readonly pendingRelationWrites = new Map<string, number>();
	private relationRevision = 0;

	filamentById(id: string): Filament | undefined {
		return this.filaments.find((f) => f.id === id);
	}
	vendorById(id: string): Vendor | undefined {
		return this.vendors.find((v) => v.id === id);
	}
	spoolById(id: number): Spool | undefined {
		return this.spools.find((s) => s.id === id);
	}
	isSpoolUncertain(id: number): boolean {
		return (this.uncertainSpools[id]?.length ?? 0) > 0;
	}
	uncertainSpoolIds(): number[] {
		return Object.keys(this.uncertainSpools).map(Number);
	}
	uncertainSpoolFields(id: number): GroupField[] {
		return [...new Set((this.uncertainSpools[id] ?? []).map(({ field }) => field))];
	}
	spoolUncertainty(id: number, field: GroupField): number | undefined {
		return this.uncertainSpools[id]?.filter((entry) => entry.field === field).at(-1)?.revision;
	}
	markSpoolUncertain(id: number, field: GroupField): number {
		const revision = ++this.nextUncertainty;
		const entries = this.uncertainSpools[id] ?? [];
		this.uncertainSpools = {
			...this.uncertainSpools,
			[id]: [...entries, { field, revision }]
		};
		for (const observer of this.spoolUncertaintyObservers) observer(id);
		return revision;
	}
	holdSpoolUncertainty(id: number, field: GroupField, revision: number, pendingValue: string) {
		const entries = this.uncertainSpools[id];
		if (!entries?.some((entry) => entry.field === field && entry.revision === revision)) return;
		this.uncertainSpools = {
			...this.uncertainSpools,
			[id]: entries.map((entry) =>
				entry.field === field && entry.revision === revision ? { ...entry, pendingValue } : entry
			)
		};
	}
	hasPendingSpoolRename(id: number, field: GroupField, value: string): boolean {
		return (this.uncertainSpools[id] ?? []).some(
			(entry) => entry.field === field && entry.pendingValue === value
		);
	}
	pendingSpoolRenameValues(id: number, field: GroupField, revision: number): string[] {
		return (this.uncertainSpools[id] ?? [])
			.filter((entry) => entry.field === field && entry.revision <= revision)
			.flatMap((entry) => (entry.pendingValue === undefined ? [] : [entry.pendingValue]));
	}
	resolveSpoolUncertainty(id: number, field: GroupField, revision: number) {
		if (this.spoolUncertainty(id, field) !== revision) return;
		this.removeSpoolUncertainties(id, (entry) => entry.field === field && entry.revision <= revision);
	}
	cancelSpoolUncertainty(id: number, field: GroupField, revision: number) {
		this.removeSpoolUncertainties(id, (entry) => entry.field === field && entry.revision === revision);
	}
	private removeSpoolUncertainties(
		id: number,
		remove: (entry: { field: GroupField; revision: number; pendingValue?: string }) => boolean
	) {
		const entries = (this.uncertainSpools[id] ?? []).filter((entry) => !remove(entry));
		const next = { ...this.uncertainSpools };
		if (entries.length) next[id] = entries;
		else delete next[id];
		this.uncertainSpools = next;
	}
	vendorOf(f: Filament): Vendor {
		return (
			this.vendorById(f.vendorId) ?? {
				id: '?',
				name: '?',
				emptyWeight: 0,
				comment: '',
				registeredLabel: '',
				extra: {}
			}
		);
	}
	spoolsOfFilament(filamentId: string): Spool[] {
		return this.spools.filter((s) => s.filamentId === filamentId);
	}
	filamentsOfVendor(vendorId: string): Filament[] {
		return this.filaments.filter((f) => f.vendorId === vendorId);
	}

	// --- upserts (new array refs so $state/$derived recompute) --------------

	observeSpoolUpserts(observer: (spool: Spool) => void): () => void {
		this.spoolUpsertObservers.add(observer);
		return () => this.spoolUpsertObservers.delete(observer);
	}

	observeSpoolUncertainty(observer: (id: number) => void): () => void {
		this.spoolUncertaintyObservers.add(observer);
		return () => this.spoolUncertaintyObservers.delete(observer);
	}

	observeRelationDrafts(observer: () => void): () => void {
		this.relationDraftObservers.add(observer);
		return () => this.relationDraftObservers.delete(observer);
	}

	flushRelationDrafts() {
		for (const observer of this.relationDraftObservers) observer();
	}

	trackRelationWrite(kind: 'filament' | 'vendor', id: string, pending: Promise<unknown>) {
		const key = `${kind}:${id}`;
		this.pendingRelationWrites.set(key, (this.pendingRelationWrites.get(key) ?? 0) + 1);
		const finish = () => {
			const remaining = (this.pendingRelationWrites.get(key) ?? 1) - 1;
			if (remaining) this.pendingRelationWrites.set(key, remaining);
			else this.pendingRelationWrites.delete(key);
		};
		void pending.then(finish, finish);
	}

	relationReadRevision(): number {
		return this.relationRevision;
	}

	canCacheRelation(kind: 'filament' | 'vendor', id: string, revision: number): boolean {
		const key = `${kind}:${id}`;
		return !this.pendingRelationWrites.has(key) && (this.relationRevisions.get(key) ?? 0) <= revision;
	}

	cacheFilamentRead(filament: Filament, revision: number): Filament {
		if (this.canCacheRelation('filament', filament.id, revision)) this.upsertFilament(filament);
		const cached = this.filamentById(filament.id);
		if (!cached) throw new Error(`Filament ${filament.id} changed while it was being loaded`);
		return cached;
	}

	cacheVendorRead(vendor: Vendor, revision: number): Vendor {
		if (this.canCacheRelation('vendor', vendor.id, revision)) this.upsertVendor(vendor);
		const cached = this.vendorById(vendor.id);
		if (!cached) throw new Error(`Vendor ${vendor.id} changed while it was being loaded`);
		return cached;
	}

	private noteRelationChange(kind: 'filament' | 'vendor', id: string) {
		this.relationRevisions.set(`${kind}:${id}`, ++this.relationRevision);
	}

	/** Register rename candidates before deciding whether a remote snapshot is safe to cache. */
	considerSpool(s: Spool): boolean {
		for (const observer of this.spoolUpsertObservers) observer(s);
		return !this.isSpoolUncertain(s.id);
	}

	upsertSpool(s: Spool) {
		this.considerSpool(s);
		this.spools = this.spools.some((x) => x.id === s.id)
			? this.spools.map((x) => (x.id === s.id ? s : x))
			: [...this.spools, s];
	}
	upsertFilament(f: Filament) {
		this.noteRelationChange('filament', f.id);
		this.filaments = this.filaments.some((x) => x.id === f.id)
			? this.filaments.map((x) => (x.id === f.id ? f : x))
			: [...this.filaments, f];
	}
	upsertVendor(v: Vendor) {
		this.noteRelationChange('vendor', v.id);
		this.vendors = this.vendors.some((x) => x.id === v.id)
			? this.vendors.map((x) => (x.id === v.id ? v : x))
			: [...this.vendors, v];
	}

	upsertSpools(list: Spool[]) {
		for (const s of list) this.upsertSpool(s);
	}
	upsertFilaments(list: Filament[]) {
		for (const f of list) this.upsertFilament(f);
	}
	upsertVendors(list: Vendor[]) {
		for (const v of list) this.upsertVendor(v);
	}

	// --- removals -----------------------------------------------------------
	// Used both by live `deleted` events and by our own deletes, so a delete made
	// here drops out of every view immediately instead of waiting for the round
	// trip through the websocket.

	removeSpool(id: number) {
		this.spools = this.spools.filter((s) => s.id !== id);
		if (this.uncertainSpools[id]) {
			const next = { ...this.uncertainSpools };
			delete next[id];
			this.uncertainSpools = next;
		}
	}
	removeFilament(id: string) {
		this.noteRelationChange('filament', id);
		this.filaments = this.filaments.filter((f) => f.id !== id);
	}
	/**
	 * Drop a vendor and clear it off every cached filament that referenced it.
	 *
	 * The server does the same on its side — filament.vendor_id is nullable, so a
	 * filament outlives its manufacturer with the field set to null — but it does
	 * not broadcast those filaments (see spoolman/database/vendor.py `delete`).
	 * This is the cache's only chance to stop pointing at a vendor that is gone.
	 */
	removeVendor(id: string) {
		this.noteRelationChange('vendor', id);
		this.vendors = this.vendors.filter((v) => v.id !== id);
		if (this.filaments.some((f) => f.vendorId === id)) {
			for (const filament of this.filaments)
				if (filament.vendorId === id) this.noteRelationChange('filament', filament.id);
			this.filaments = this.filaments.map((f) => (f.vendorId === id ? { ...f, vendorId: '' } : f));
		}
	}

	/** Patch a cached spool in place (optimistic local edit). */
	patchSpool(id: number, patch: Partial<Spool>) {
		const s = this.spoolById(id);
		if (s) this.upsertSpool({ ...s, ...patch });
	}
	patchFilament(id: string, patch: Partial<Filament>) {
		const f = this.filamentById(id);
		if (f) this.upsertFilament({ ...f, ...patch });
	}
	patchVendor(id: string, patch: Partial<Vendor>) {
		const v = this.vendorById(id);
		if (v) this.upsertVendor({ ...v, ...patch });
	}

	/**
	 * Recompute the weights of cached spools that inherit them from `f`.
	 *
	 * The server does not re-broadcast a filament's spools when the filament changes
	 * (that fan-out is unbounded — see spoolman/database/filament.py `update`), so a
	 * filament event is our only signal.
	 *
	 * Only the *stored* weights need this. Remaining length — the value the fan-out
	 * was originally added for — is not cached at all: SpoolInspector computes it as
	 * `lengthMeters(spool.remaining, filament)` where `filament` is $derived from this
	 * cache, so upserting the filament above already refreshes it with the new density
	 * and diameter. The same goes for every other filament value a spool row shows.
	 *
	 * What has nowhere else to come from is a spool with no `initial_weight` of its
	 * own, whose initial/remaining weights the server derived from `filament.weight`.
	 * Mirror `Spool.from_db`'s formula — including its clamp at 0 — so an over-used
	 * spool doesn't go negative.
	 */
	private reweighSpoolsOfFilament(f: Filament) {
		let changed = false;
		const next = this.spools.map((s) => {
			if (s.filamentId !== f.id || s.initialOverride !== undefined) return s;
			if (s.initial === f.weight) return s;
			changed = true;
			return { ...s, initial: f.weight, remaining: Math.max(f.weight - s.usedWeight, 0) };
		});
		if (changed) this.spools = next;
	}

	// --- live events (raw API payload → cache) ------------------------------

	ingest(event: LiveEvent) {
		const payload = event.payload;
		const revision = this.relationReadRevision();
		if (event.resource === 'spool') {
			const id = Number(event.id);
			if (event.type === 'deleted') this.removeSpool(id);
			else if (payload) {
				this.upsertSpool(mapSpool(payload));
				// Spool payloads embed their filament (+ vendor); keep those fresh too.
				const f = payload.filament as Record<string, unknown> | undefined;
				if (f) {
					const filament = mapFilament(f);
					if (this.canCacheRelation('filament', filament.id, revision)) this.upsertFilament(filament);
					const v = f.vendor as Record<string, unknown> | undefined;
					if (v) {
						const vendor = mapVendor(v);
						if (this.canCacheRelation('vendor', vendor.id, revision)) this.upsertVendor(vendor);
					}
				}
			}
		} else if (event.resource === 'filament') {
			const id = String(event.id);
			if (event.type === 'deleted') this.removeFilament(id);
			else if (payload) {
				const f = mapFilament(payload);
				if (this.canCacheRelation('filament', f.id, revision)) {
					this.upsertFilament(f);
					this.reweighSpoolsOfFilament(f);
				}
				const v = payload.vendor as Record<string, unknown> | undefined;
				if (v) {
					const vendor = mapVendor(v);
					if (this.canCacheRelation('vendor', vendor.id, revision)) this.upsertVendor(vendor);
				}
			}
		} else if (event.resource === 'vendor') {
			const id = String(event.id);
			if (event.type === 'deleted') this.removeVendor(id);
			else if (payload) {
				const vendor = mapVendor(payload);
				if (this.canCacheRelation('vendor', vendor.id, revision)) this.upsertVendor(vendor);
			}
		}
	}
}

export const inventory = new Inventory();
