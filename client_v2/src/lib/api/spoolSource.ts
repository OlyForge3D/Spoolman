import type {
	Extra,
	Filament,
	FilamentPatch,
	MultiColorDirection,
	Spool,
	SpoolPatch,
	Vendor,
	VendorPatch
} from '$lib/types';
import type { GroupField, GroupQuery, GroupSummary, Page, SpoolQuery } from './types';
import {
	getList,
	getJson,
	patchJson,
	postJson,
	putJson,
	deleteResource,
	HttpError,
	WriteQueueTimeoutError
} from './http';
import type { QueryParams } from './http';
import {
	mapFilament,
	mapGroup,
	mapSpool,
	mapVendor,
	spoolPatchToApi,
	filamentPatchToApi,
	vendorPatchToApi,
	colorFieldsToApi
} from './map';
import { inventory } from '$lib/stores/inventory.svelte';
import { fields } from '$lib/stores/fields.svelte';
import { isDateFilterProp, parseDateFilter, resolveDateFilter } from '$lib/library/dateFilter';
import { filamentLabel, type FilterOption } from '$lib/utils/library';
import type { EntityType } from './fields';
import { type ExternalFilament } from './external';
import { searchAll } from './search';
import { loadLayout } from '$lib/dashboard/layout';
import { withExtraDefaults } from '$lib/utils/extraDefaults';
import { cacheSpoolRead } from './cacheSpoolRead';
import {
	isCurrentSpoolRead,
	noteSpoolRename,
	possiblyStaleEventFields,
	readSpoolSnapshot,
	spoolHasFieldValue
} from './spoolReadFence';
import type { LiveEvent } from './live';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

// HTTP-backed data source against the real Spoolman API. It also populates the
// reactive cache with every entity it fetches, so detail views (which read the
// cache) have their data as soon as it's visible in the list.

export interface NewFilamentDraft {
	name: string;
	vendorName: string;
	material: string;
	density: number;
	diameter: number;
	weight?: number;
	spoolWeight?: number;
	/** One or more hex colors (with or without '#'); 2+ makes it multi-color. */
	colors?: string[];
	multiColorDirection?: MultiColorDirection;
	nozzleTemp?: number;
	bedTemp?: number;
	price?: number;
	articleNumber?: string;
	/** Scannable retail barcode, already normalized to a 14 digit GTIN. */
	gtin?: string;
	comment?: string;
	/** Custom-field values to carry over (used when duplicating a filament). */
	extra?: Extra;
	/** Custom-field values for the manufacturer, applied only if it is created here. */
	vendorExtra?: Extra;
}

export class SpoolBatchError extends Error {
	constructor(
		readonly created: number,
		readonly cause: unknown
	) {
		super('Not all spools could be added');
		this.name = 'SpoolBatchError';
	}
}

export interface SpoolRenameResult {
	updated: number;
	cacheRefreshed: boolean;
}

export class SpoolRenameUncertainError extends Error {
	constructor(cause: unknown) {
		super('The group rename may have completed; check the dashboard before retrying.', { cause });
		this.name = 'SpoolRenameUncertainError';
	}
}

export interface StagedSpoolPage extends Page<Spool> {
	isCurrent(): boolean;
	commit(): boolean;
}

// Map a filter chip prop → API query param. Values are quoted for exact match.
const FILTER_PARAM: Record<string, string> = {
	filament: 'filament.id',
	material: 'filament.material',
	vendor: 'filament.vendor.name',
	direction: 'filament.multi_color_direction',
	location: 'location',
	lot: 'lot_nr',
	// Not in the filter menu, which picks manufacturers by name: the manufacturer
	// inspector's "Show as a list" filters by id, so two of the same name stay
	// apart, and the filament list narrows its section totals the same way.
	vendorId: 'filament.vendor.id'
};

// Filters whose values are passed through verbatim rather than double-quoted for
// exact string match. `filament` filters by numeric id, which the API parses as
// an int and would reject if quoted. `direction` is passed verbatim so its empty
// value (single-color = no direction) hits the backend's NULL-match branch, which
// quoting would turn into an exact match on the literal empty string instead.
// `vendorId` is numeric like `filament`.
const UNQUOTED_FILTERS = new Set(['filament', 'direction', 'vendorId']);

// A filter prop is either one of the fixed categories above or an extra-field
// filter whose prop is already the query param the backend expects — `extra.<key>`
// for spool fields, `filament.extra.<key>` / `filament.vendor.extra.<key>` for a
// spool's filament or vendor.
function filterParam(prop: string): string | undefined {
	return prop.includes('extra.') ? prop : FILTER_PARAM[prop];
}

function quote(v: string): string {
	return `"${v}"`;
}

function applyFilters(params: QueryParams, filters: Record<string, string[]>) {
	for (const [prop, values] of Object.entries(filters)) {
		if (!values.length) continue;
		// A date filter is a range rather than a set of values, and the API spells one
		// as `<field>=<start>|<end>` with either end optional — the same grammar its
		// datetime extra-field filters take. An empty value asks for "no timestamp at
		// all", the way an empty value means "unset" for every other filter here.
		//
		// The bounds are resolved at request time, so a relative range like "the last
		// 24 hours" is measured from now on every fetch rather than from whenever the
		// chip was created.
		if (isDateFilterProp(prop)) {
			const filter = parseDateFilter(values[values.length - 1]);
			if (!filter) continue;
			const { after, before, unset } = resolveDateFilter(filter);
			params[prop] = unset ? '' : `${after ?? ''}|${before ?? ''}`;
			continue;
		}
		const key = filterParam(prop);
		if (!key) continue;
		const encode = UNQUOTED_FILTERS.has(prop) ? (v: string) => v : quote;
		params[key] = values.map(encode).join(',');
	}
}

function sortParam(sort: { field: string; dir: string }[]): string | undefined {
	return sort.length ? sort.map((s) => `${s.field}:${s.dir}`).join(',') : undefined;
}

function scopeParams(params: QueryParams, scope: SpoolQuery['groupScope']) {
	if (!scope) return;
	// An empty key is the group of spools whose value is unset. Every string-valued
	// field spells that as an empty filter, which the backend reads as "null or empty"
	// (and, for an extra field, "no row for this key either").
	const exact = (v: string) => (v === '' ? '' : quote(v));
	switch (scope.field) {
		case 'filament':
			params['filament.id'] = scope.key;
			break;
		case 'vendor':
			params['filament.vendor.id'] = scope.key === '' ? '-1' : scope.key;
			break;
		case 'material':
			params['filament.material'] = exact(scope.key);
			break;
		case 'location':
			params['location'] = exact(scope.key);
			break;
		default:
			// `extra.<key>`, which is already the query param the backend expects.
			params[scope.field] = exact(scope.key);
			break;
	}
}

/** Treat a 404 as "no such entity" (undefined); re-throw anything else. */
function swallow404(e: unknown): null {
	if (e instanceof HttpError && e.status === 404) return null;
	throw e;
}

function cacheMappedSpools(raw: unknown[], spools: Spool[]): void {
	for (const [index, spool] of spools.entries())
		spools[index] = cacheSpoolRead((raw as Json[])[index], spool);
}

function cacheSpools(raw: unknown[]): Spool[] {
	const spools = (raw as Json[]).map(mapSpool);
	cacheMappedSpools(raw, spools);
	return spools;
}

function withServerSpoolField(spool: Spool, server: Spool, field: GroupField): Spool {
	if (field === 'location') return { ...spool, location: server.location };
	const key = field.slice('extra.'.length);
	const extra = { ...spool.extra };
	if (server.extra[key] === undefined) delete extra[key];
	else extra[key] = server.extra[key];
	return { ...spool, extra };
}

const WRITE_WAIT_TIMEOUT_MS = 30_000;
const RENAME_REFRESH_TIMEOUT_MS = 10_000;
const RENAME_REFRESH_MAX_TIMEOUT_MS = 120_000;
const RENAME_REFRESH_WAVE_BUDGET_MS = 1_000;
const RENAME_REFRESH_CONCURRENCY = 4;

interface ActiveRename {
	field: GroupField;
	value: string;
	candidates: Map<number, number>;
	accepting: boolean;
}

class HttpSpoolSource {
	private readonly pendingWrites = new Map<string, Promise<unknown>>();
	private pendingSpoolBulk: Promise<unknown> | undefined;
	private spoolBulkRevision = 0;
	private readonly activeRenames = new Set<ActiveRename>();
	private readonly ambiguousRenames: { field: GroupField; value: string }[] = [];
	private readonly eventRefreshes = new Set<number>();
	private readonly eventRefreshQueue: number[] = [];
	private readonly eventRefreshGenerations = new Map<number, number>();
	private readonly eventFullRefreshNeeded = new Set<number>();
	private eventRefreshesInFlight = 0;
	private spoolDeletionRevision = 0;
	private nextSpoolCreation = 0;

	constructor() {
		inventory.observeSpoolUpserts((spool) => {
			if (
				[...this.activeRenames].some(
					(active) => active.accepting && spoolHasFieldValue(spool, active.field, active.value)
				)
			)
				this.addRenameCandidates([spool.id]);
			for (const { field, value } of this.ambiguousRenames) {
				if (
					!spoolHasFieldValue(spool, field, value) ||
					inventory.hasPendingSpoolRename(spool.id, field, value)
				)
					continue;
				const revision = inventory.markSpoolUncertain(spool.id, field);
				inventory.holdSpoolUncertainty(spool.id, field, revision, value);
			}
		});
	}

	private quarantineEventSpool(spool: Spool): boolean {
		const possiblyStale = new Set([
			...possiblyStaleEventFields(spool, inventory.spoolById(spool.id)),
			...inventory.uncertainSpoolFields(spool.id)
		]);
		for (const field of possiblyStale) {
			if (inventory.spoolUncertainty(spool.id, field) === undefined)
				inventory.markSpoolUncertain(spool.id, field);
		}
		return possiblyStale.size > 0;
	}

	private refreshEventSpool(id: number) {
		this.eventRefreshGenerations.set(id, (this.eventRefreshGenerations.get(id) ?? 0) + 1);
		this.eventFullRefreshNeeded.add(id);
		this.enqueueEventRefresh(id);
	}

	private enqueueEventRefresh(id: number) {
		if (this.eventRefreshes.has(id)) return;
		this.eventRefreshes.add(id);
		this.eventRefreshQueue.push(id);
		this.drainEventRefreshes();
	}

	private drainEventRefreshes() {
		while (this.eventRefreshesInFlight < RENAME_REFRESH_CONCURRENCY && this.eventRefreshQueue.length) {
			const id = this.eventRefreshQueue.shift()!;
			const generation = this.eventRefreshGenerations.get(id);
			this.eventRefreshesInFlight++;
			void this.refreshUncertainSpools([id])
				.then((refreshed) => {
					if (!refreshed) console.error('Failed to verify spool %s after a potentially stale event', id);
				})
				.catch((error) =>
					console.error('Failed to verify spool %s after a potentially stale event', id, error)
				)
				.finally(() => {
					this.eventRefreshes.delete(id);
					this.eventRefreshesInFlight--;
					if (this.eventRefreshGenerations.get(id) !== generation) this.enqueueEventRefresh(id);
					else this.eventRefreshGenerations.delete(id);
					this.drainEventRefreshes();
				});
		}
	}

	ingestLiveEvent(event: LiveEvent): void {
		if (event.resource === 'spool' && event.type === 'deleted') this.spoolDeletionRevision++;
		const spool =
			event.resource === 'spool' && event.type !== 'deleted' && event.payload
				? mapSpool(event.payload)
				: undefined;
		const possiblyStale = spool ? this.quarantineEventSpool(spool) : false;
		const uncertain = spool ? !inventory.considerSpool(spool) || possiblyStale : false;
		if (spool && uncertain) this.refreshEventSpool(spool.id);
		else inventory.ingest(event);
	}

	ingestScannedSpool(spool: Spool): boolean {
		const possiblyStale = this.quarantineEventSpool(spool);
		const uncertain = !inventory.considerSpool(spool) || possiblyStale;
		if (uncertain) {
			this.refreshEventSpool(spool.id);
			return false;
		}
		inventory.upsertSpool(spool);
		return true;
	}

	// Full write responses replace the cached entity, so writes to the same
	// entity must land in order, even when they come from different controls.
	private write<T>(key: string, action: () => Promise<T>): Promise<T> {
		const previous = this.pendingWrites.get(key);
		const dependencies = [previous, key.startsWith('spool:') ? this.pendingSpoolBulk : undefined].filter(
			(promise): promise is Promise<unknown> => promise !== undefined
		);
		const { result } = this.schedule(dependencies, action);
		// An expired operation was never sent. Keep its own earlier write as the
		// lane barrier, but do not keep an unrelated, expired bulk operation there.
		const lane = result.catch((error: unknown) => {
			if (error instanceof WriteQueueTimeoutError && previous) return previous;
			throw error;
		});
		this.pendingWrites.set(key, lane);
		const clear = () => {
			if (this.pendingWrites.get(key) === lane) this.pendingWrites.delete(key);
		};
		void lane.then(clear, clear);
		return result;
	}

	// A bulk rename must follow every earlier spool write, and later spool writes
	// must follow it, even when the renamed group has unloaded members.
	private writeSpools<T>(action: () => Promise<T>): Promise<T> {
		const dependencies = [...this.pendingWrites.entries()]
			.filter(([key]) => key.startsWith('spool:'))
			.map(([, promise]) => promise);
		const previousBulk = this.pendingSpoolBulk;
		if (previousBulk) dependencies.push(previousBulk);
		const { result } = this.schedule(dependencies, action);
		// An expired rename was never sent. Release it without dropping an
		// earlier bulk write that is still in flight.
		const barrier = result.catch((error: unknown) => {
			if (error instanceof WriteQueueTimeoutError && previousBulk) return previousBulk;
			throw error;
		});
		this.pendingSpoolBulk = barrier;
		const clear = () => {
			if (this.pendingSpoolBulk === barrier) this.pendingSpoolBulk = undefined;
		};
		void barrier.then(clear, clear);
		return result;
	}

	private schedule<T>(dependencies: Promise<unknown>[], action: () => Promise<T>) {
		if (dependencies.length === 0) {
			const result = action();
			return { result, tail: result };
		}

		let expired = false;
		let timer: ReturnType<typeof setTimeout>;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				expired = true;
				reject(new WriteQueueTimeoutError());
			}, WRITE_WAIT_TIMEOUT_MS);
		});
		const tail = Promise.allSettled(dependencies).then(() => {
			clearTimeout(timer);
			// A caller already told its write failed must not have it run later.
			if (expired) throw new WriteQueueTimeoutError();
			return action();
		});
		return { result: Promise.race([tail, timeout]), tail };
	}

	async listGroups(query: GroupQuery): Promise<Page<GroupSummary>> {
		const params: QueryParams = {
			group_by: query.field,
			sort: sortParam(query.sort),
			limit: query.limit,
			offset: query.offset,
			allow_archived: query.allowArchived ? 'true' : undefined,
			include_empty: query.includeEmpty ? 'true' : undefined,
			preview: query.preview ? 'true' : undefined
		};
		applyFilters(params, query.filters);

		return readSpoolSnapshot(
			() => getList('/spool/group', params, query.signal),
			({ items, total, totalSpools, totalRemaining }) => {
				for (const g of items as Json[]) {
					if (g.filament) {
						inventory.upsertFilament(mapFilament(g.filament));
						if (g.filament.vendor) inventory.upsertVendor(mapVendor(g.filament.vendor));
					}
					if (g.vendor) inventory.upsertVendor(mapVendor(g.vendor));
				}
				return { items: (items as Json[]).map(mapGroup), total, totalSpools, totalRemaining };
			},
			query.signal
		);
	}

	async stageSpools(query: SpoolQuery): Promise<StagedSpoolPage> {
		const params: QueryParams = {
			sort: sortParam(query.sort),
			limit: query.limit,
			offset: query.offset,
			allow_archived: query.allowArchived ? 'true' : undefined
		};
		applyFilters(params, query.filters);
		scopeParams(params, query.groupScope);

		return readSpoolSnapshot(
			() => getList('/spool', params, query.signal),
			({ items, total }, revision) => {
				const spools = (items as Json[]).map(mapSpool);
				const isCurrent = () => isCurrentSpoolRead(revision);
				return {
					items: spools,
					total,
					isCurrent,
					commit: () => {
						if (!isCurrent()) return false;
						cacheMappedSpools(items, spools);
						return true;
					}
				};
			},
			query.signal
		);
	}

	async listSpools(query: SpoolQuery): Promise<Page<Spool>> {
		for (let attempt = 0; attempt < 4; attempt++) {
			const page = await this.stageSpools(query);
			if (page.commit()) return { items: page.items, total: page.total };
		}
		throw new Error('Spool data kept changing while it was being loaded');
	}

	/** Load and cache one page of filaments, including the catalog total. */
	async listFilamentPage(
		query: Pick<SpoolQuery, 'sort' | 'limit' | 'offset' | 'signal'>
	): Promise<Page<Filament>> {
		const { items, total } = await getList(
			'/filament',
			{ sort: sortParam(query.sort), limit: query.limit, offset: query.offset },
			query.signal
		);
		const filaments = (items as Json[]).map((f) => {
			if (f.vendor) inventory.upsertVendor(mapVendor(f.vendor));
			return mapFilament(f);
		});
		inventory.upsertFilaments(filaments);
		return { items: filaments, total };
	}

	/** Load a batch for label previews, newest first. */
	async listFilaments(limit = 1000, signal?: AbortSignal): Promise<Filament[]> {
		const { items } = await this.listFilamentPage({
			sort: [{ field: 'id', dir: 'desc' }],
			limit,
			offset: 0,
			signal
		});
		return items;
	}

	async searchFilaments(query: string, limit = 8): Promise<Filament[]> {
		const q = query.trim();
		if (!q) {
			// No query yet: browse a slice of the catalog (sorted by name) so the
			// picker has something to show as soon as it opens.
			const params: QueryParams = { limit, sort: 'name:asc' };
			const items = await getJson<Json[]>('/filament', params);
			const filaments = items.map((f) => {
				if (f.vendor) inventory.upsertVendor(mapVendor(f.vendor));
				return mapFilament(f);
			});
			inventory.upsertFilaments(filaments);
			return filaments;
		}
		// Reuse the cross-entity /search backend that powers the library search bar,
		// so the picker matches on name, material, article number, comment, extra
		// fields and colour — not just the filament name. We only want the filament
		// hits here (results already upsert into the reactive cache).
		const { filaments } = await searchAll(q, 20);
		return filaments.map((m) => m.entity).slice(0, limit);
	}

	async searchExternalFilaments(
		query: string,
		limit: number,
		offset = 0,
		signal?: AbortSignal
	): Promise<Page<ExternalFilament>> {
		// Filtering happens server-side (/external/filament/search) so the whole catalog
		// — thousands of entries — never has to be downloaded to the client.
		const q = query.trim();
		if (!q) return { items: [], total: 0 };
		const { items, total } = await getList('/external/filament/search', { query: q, limit, offset }, signal);
		return { items: items as ExternalFilament[], total };
	}

	/**
	 * Import a SpoolmanDB filament into the local catalog (creating its vendor if
	 * needed), de-duplicated by external_id. Returns the local filament.
	 */
	async importExternalFilament(ext: ExternalFilament): Promise<Filament> {
		// Already imported?
		const existing = await getJson<Json[]>('/filament', { external_id: quote(ext.id) });
		if (existing.length) {
			if (existing[0].vendor) inventory.upsertVendor(mapVendor(existing[0].vendor));
			const f = mapFilament(existing[0]);
			inventory.upsertFilament(f);
			return f;
		}

		const defaults = async (entity: 'filament' | 'vendor'): Promise<Extra> => {
			if (!fields.isLoaded(entity)) await fields.loadRequired(entity);
			return withExtraDefaults(fields.get(entity), {});
		};
		const filamentExtra = await defaults('filament');

		// Match the vendor by external_id first, then by name.
		let vendorId: number | undefined;
		const vendors = await getJson<Json[]>('/vendor', { external_id: quote(ext.manufacturer) });
		if (vendors.length) {
			inventory.upsertVendor(mapVendor(vendors[0]));
			vendorId = vendors[0].id;
		} else {
			vendorId = await this.getOrCreateVendor(ext.manufacturer, () => defaults('vendor'), ext.manufacturer);
		}

		const body: Json = {
			name: ext.name,
			material: ext.material,
			vendor_id: vendorId,
			density: ext.density,
			diameter: ext.diameter,
			weight: ext.weight,
			spool_weight: ext.spool_weight ?? undefined,
			settings_extruder_temp: ext.extruder_temp ?? undefined,
			settings_bed_temp: ext.bed_temp ?? undefined,
			external_id: ext.id,
			extra: Object.keys(filamentExtra).length ? filamentExtra : undefined
		};
		if (ext.color_hexes && ext.color_hexes.length) {
			body.multi_color_hexes = ext.color_hexes.map((h) => h.replace(/^#/, '')).join(',');
			if (ext.multi_color_direction) body.multi_color_direction = ext.multi_color_direction;
		} else if (ext.color_hex) {
			body.color_hex = ext.color_hex.replace(/^#/, '');
		}

		const created = await postJson<Json>('/filament', body);
		const f = mapFilament(created);
		inventory.upsertFilament(f);
		return f;
	}

	/**
	 * Find a vendor by (case-insensitive) name or create it; returns its id.
	 *
	 * `extra` and `externalId` only apply to a vendor this call creates — matching an existing
	 * name links that record, it never edits it.
	 */
	async getOrCreateVendor(
		name: string,
		extra?: Extra | (() => Promise<Extra>),
		externalId?: string
	): Promise<number | undefined> {
		const trimmed = name.trim();
		if (!trimmed) return undefined;
		const all = await getJson<Json[]>('/vendor');
		const match = all.find((v) => (v.name ?? '').toLowerCase() === trimmed.toLowerCase());
		if (match) {
			inventory.upsertVendor(mapVendor(match));
			return match.id;
		}
		const newExtra = typeof extra === 'function' ? await extra() : extra;
		const created = await postJson<Json>('/vendor', {
			name: trimmed,
			external_id: externalId,
			extra: newExtra && Object.keys(newExtra).length ? newExtra : undefined
		});
		inventory.upsertVendor(mapVendor(created));
		return created.id;
	}

	/** Create a brand-new filament (and its vendor if needed) from a draft. */
	async createFilament(draft: NewFilamentDraft): Promise<Filament> {
		const vendorId = await this.getOrCreateVendor(draft.vendorName, draft.vendorExtra);
		const body: Json = {
			name: draft.name || undefined,
			material: draft.material || undefined,
			vendor_id: vendorId,
			density: draft.density,
			diameter: draft.diameter,
			weight: draft.weight || undefined,
			spool_weight: draft.spoolWeight,
			settings_extruder_temp: draft.nozzleTemp,
			settings_bed_temp: draft.bedTemp,
			price: draft.price,
			article_number: draft.articleNumber || undefined,
			gtin: draft.gtin || undefined,
			comment: draft.comment || undefined,
			extra: draft.extra && Object.keys(draft.extra).length ? draft.extra : undefined,
			...colorFieldsToApi(draft.colors, draft.multiColorDirection)
		};
		const created = await postJson<Json>('/filament', body);
		const f = mapFilament(created);
		inventory.upsertFilament(f);
		return f;
	}

	/**
	 * Every manufacturer, ordered by name and cached.
	 *
	 * Unlike filaments there is no `/vendor` search endpoint and no external
	 * manufacturer catalog to page through, but the list is small — a manufacturer
	 * covers a whole brand, so even a large library has a few dozen — so the
	 * pickers fetch it whole and filter it in the browser.
	 */
	async listVendors(signal?: AbortSignal): Promise<Vendor[]> {
		const items = await getJson<Json[]>('/vendor', {}, signal);
		const vendors = items.map(mapVendor);
		inventory.upsertVendors(vendors);
		return vendors.sort((a, b) => a.name.localeCompare(b.name));
	}

	async listFilamentsByVendor(vendorId: string): Promise<Filament[]> {
		const items = await getJson<Json[]>('/filament', { 'vendor.id': vendorId });
		const filaments = items.map((f) => {
			if (f.vendor) inventory.upsertVendor(mapVendor(f.vendor));
			return mapFilament(f);
		});
		inventory.upsertFilaments(filaments);
		return filaments;
	}

	// --- single-entity fetches (deep links) ---------------------------------
	// The reactive cache is normally filled by the list/search/live paths, so a
	// deep link straight to an entity that isn't on the loaded page finds nothing.
	// These fetch one entity by id and upsert it (plus its embedded relations) so
	// the inspector resolves regardless of list state. A 404 (stale link, deleted
	// entity) resolves to undefined rather than throwing.

	async fetchSpool(id: number, signal?: AbortSignal): Promise<Spool | undefined> {
		return readSpoolSnapshot(
			() => getJson<Json | null>(`/spool/${id}`, {}, signal).catch(swallow404),
			(s) => (s ? cacheSpools([s])[0] : undefined),
			signal
		);
	}
	async fetchFilament(id: string, signal?: AbortSignal): Promise<Filament | undefined> {
		const f = await getJson<Json | null>(`/filament/${id}`, {}, signal).catch(swallow404);
		if (!f) return undefined;
		if (f.vendor) inventory.upsertVendor(mapVendor(f.vendor));
		const filament = mapFilament(f);
		inventory.upsertFilament(filament);
		return filament;
	}
	async fetchVendor(id: string, signal?: AbortSignal): Promise<Vendor | undefined> {
		const v = await getJson<Json | null>(`/vendor/${id}`, {}, signal).catch(swallow404);
		if (!v) return undefined;
		const vendor = mapVendor(v);
		inventory.upsertVendor(vendor);
		return vendor;
	}

	// --- writes -------------------------------------------------------------

	async saveSpool(id: number, patch: SpoolPatch): Promise<void> {
		return this.write(`spool:${id}`, async () => {
			const updated = await patchJson<Json>(`/spool/${id}`, spoolPatchToApi(patch));
			inventory.upsertSpool(mapSpool(updated));
		});
	}
	async setSpoolArchived(id: number, archived: boolean): Promise<void> {
		await this.saveSpool(id, { archived });
	}
	/** Consume (or, if negative, add back) filament by length. */
	async useSpoolLength(id: number, length: number): Promise<Spool> {
		return this.write(`spool:${id}`, async () => {
			const updated = await putJson<Json>(`/spool/${id}/use`, { use_length: length });
			const spool = mapSpool(updated);
			inventory.upsertSpool(spool);
			return spool;
		});
	}
	/** Consume (or, if negative, add back) filament by weight. */
	async useSpoolWeight(id: number, weight: number): Promise<Spool> {
		return this.write(`spool:${id}`, async () => {
			const updated = await putJson<Json>(`/spool/${id}/use`, { use_weight: weight });
			const spool = mapSpool(updated);
			inventory.upsertSpool(spool);
			return spool;
		});
	}
	/** Consume filament based on the current gross (spool + filament) weight measurement. */
	async measureSpool(id: number, weight: number): Promise<Spool> {
		return this.write(`spool:${id}`, async () => {
			const updated = await putJson<Json>(`/spool/${id}/measure`, { weight });
			const spool = mapSpool(updated);
			inventory.upsertSpool(spool);
			return spool;
		});
	}
	async saveFilament(id: string, patch: FilamentPatch): Promise<void> {
		return this.write(`filament:${id}`, async () => {
			const updated = await patchJson<Json>(`/filament/${id}`, filamentPatchToApi(patch));
			// The response embeds the manufacturer, which this patch may just have
			// changed — cache it too, so a filament re-filed under one the cache has
			// never seen resolves to a name rather than to nothing.
			if (updated.vendor) inventory.upsertVendor(mapVendor(updated.vendor));
			inventory.upsertFilament(mapFilament(updated));
		});
	}
	async saveVendor(id: string, patch: VendorPatch): Promise<void> {
		return this.write(`vendor:${id}`, async () => {
			const updated = await patchJson<Json>(`/vendor/${id}`, vendorPatchToApi(patch));
			inventory.upsertVendor(mapVendor(updated));
		});
	}
	async createSpool(body: Json): Promise<Spool> {
		return (await this.createSpools(body, 1))[0];
	}
	async createSpools(body: Json, count: number): Promise<Spool[]> {
		if (!Number.isSafeInteger(count) || count < 1)
			throw new RangeError('Spool count must be a positive integer');
		return this.write(`spool:create:${++this.nextSpoolCreation}`, async () => {
			const spools: Spool[] = [];
			for (let i = 0; i < count; i++) {
				try {
					const created = await postJson<Json>('/spool', body);
					spools.push(cacheSpools([created])[0]);
				} catch (error) {
					throw new SpoolBatchError(spools.length, error);
				}
			}
			return spools;
		});
	}

	// --- deletes ------------------------------------------------------------
	// Each drops the entity from the cache itself rather than waiting for the
	// websocket to echo it back, so the list and inspector update at once (and
	// still do when live updates are unavailable).

	/**
	 * How many spools reference this filament, archived ones included — the number
	 * that decides whether the API will let it be deleted. Asks for one row and
	 * reads X-Total-Count rather than paging the spools in.
	 */
	async countSpoolsOfFilament(id: string, signal?: AbortSignal): Promise<number> {
		const { total } = await getList(
			'/spool',
			{ 'filament.id': id, allow_archived: 'true', limit: 1 },
			signal
		);
		return total;
	}

	/**
	 * Delete a spool. Nothing references a spool, so this always succeeds — it is
	 * also the only way to free a filament for deletion, since archiving is just a
	 * flag and the foreign key still holds.
	 */
	async deleteSpool(id: number): Promise<void> {
		return this.write(`spool:${id}`, async () => {
			await deleteResource(`/spool/${id}`);
			inventory.removeSpool(id);
		});
	}

	/** Delete a filament. Rejects with a 403 HttpError if it still has spools. */
	async deleteFilament(id: string): Promise<void> {
		return this.write(`filament:${id}`, async () => {
			await deleteResource(`/filament/${id}`);
			inventory.removeFilament(id);
		});
	}

	/**
	 * Delete a manufacturer. Its filaments are NOT deleted — the server clears
	 * their vendor and leaves them in the catalog, which `removeVendor` mirrors.
	 */
	async deleteVendor(id: string): Promise<void> {
		return this.write(`vendor:${id}`, async () => {
			await deleteResource(`/vendor/${id}`);
			inventory.removeVendor(id);
		});
	}

	// --- filter option lists -----------------------------------------------

	async materials(): Promise<string[]> {
		return getJson<string[]>('/material');
	}
	/**
	 * Every filament as an option for the "filament" filter, so a spool listing can
	 * be narrowed to one specific filament (e.g. a given colour from a given
	 * manufacturer). Each option carries the filament's colours and material as
	 * well as its label, since the menu shows all three. Filaments are cached so
	 * the chosen chip can render its label from the reactive store.
	 */
	async filamentOptions(): Promise<FilterOption[]> {
		const items = await getJson<Json[]>('/filament');
		const filaments = items.map((f) => {
			if (f.vendor) inventory.upsertVendor(mapVendor(f.vendor));
			return mapFilament(f);
		});
		inventory.upsertFilaments(filaments);
		// The label already carries the manufacturer, so the material is what's left
		// to tell two same-named filaments apart; the colors are what the eye goes
		// to first. Both are free here — this fetches whole filaments anyway.
		return filaments
			.map((f) => ({
				value: f.id,
				label: filamentLabel(f, inventory.vendorOf(f)),
				meta: f.material,
				colors: f.colors,
				direction: f.multiColorDirection
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
	}
	/** Distinct values currently stored for a scalar extra field (text/single-choice). */
	async extraFieldValues(entity: EntityType, key: string): Promise<string[]> {
		return getJson<string[]>(`/field/${entity}/${encodeURIComponent(key)}/values`);
	}
	async locations(): Promise<string[]> {
		return getJson<string[]>('/location');
	}
	/**
	 * Locations to offer when placing a spool. GET /location only knows the ones that
	 * hold a spool right now, so the empty ones kept as dashboard cards (an idle
	 * toolhead, a new shelf) are added from the saved layout, as the old client did
	 * with its `locations` setting (#1261).
	 */
	async locationChoices(): Promise<string[]> {
		const [inUse, layout] = await Promise.all([
			this.locations(),
			loadLayout().catch((error: unknown) => {
				console.error('Failed to load saved dashboard locations', error);
				return null;
			})
		]);
		return [...new Set([...inUse, ...(layout?.groups.location ?? [])])].filter(Boolean).sort();
	}

	private async refreshRenamedSpool(id: number, field: GroupField, signal: AbortSignal): Promise<boolean> {
		for (let attempt = 0; attempt < 3;) {
			const pending = [this.pendingWrites.get(`spool:${id}`), this.pendingSpoolBulk].filter(
				(promise): promise is Promise<unknown> => promise !== undefined
			);
			if (pending.length) {
				const settled = await new Promise<boolean>((resolve) => {
					if (signal.aborted) {
						resolve(false);
						return;
					}
					const abort = () => resolve(false);
					signal.addEventListener('abort', abort, { once: true });
					const finish = () => {
						signal.removeEventListener('abort', abort);
						resolve(true);
					};
					void Promise.allSettled(pending).then(finish);
				});
				if (!settled) return false;
				continue;
			}
			const current = inventory.spoolById(id);
			const uncertainty = inventory.spoolUncertainty(id, field);
			const fullRefresh = this.eventFullRefreshNeeded.has(id);
			const eventGeneration = this.eventRefreshGenerations.get(id);
			const uncertainties = fullRefresh
				? inventory.uncertainSpoolFields(id).map((uncertainField) => ({
						field: uncertainField,
						revision: inventory.spoolUncertainty(id, uncertainField)!
					}))
				: uncertainty === undefined
					? []
					: [{ field, revision: uncertainty }];
			if (!current && uncertainty === undefined && !fullRefresh) return true;
			const revision = this.spoolBulkRevision;
			const deletionRevision = this.spoolDeletionRevision;
			attempt++;
			const raw = await getJson<Json | null>(`/spool/${id}`, {}, signal).catch(swallow404);
			if (
				this.spoolBulkRevision !== revision ||
				this.spoolDeletionRevision !== deletionRevision ||
				this.pendingWrites.has(`spool:${id}`) ||
				this.pendingSpoolBulk !== undefined ||
				inventory.spoolById(id) !== current ||
				this.eventRefreshGenerations.get(id) !== eventGeneration
			)
				continue;
			if (raw) {
				const server = mapSpool(raw);
				if (fullRefresh || !current) {
					// Embedded relations may have newer optimistic edits of their own.
					// Seed missing relations, but never replace an existing one here.
					if (raw.filament) {
						const filament = mapFilament(raw.filament);
						if (!inventory.filamentById(filament.id) && !this.pendingWrites.has(`filament:${filament.id}`))
							inventory.upsertFilament(filament);
						if (raw.filament.vendor) {
							const vendor = mapVendor(raw.filament.vendor);
							if (!inventory.vendorById(vendor.id) && !this.pendingWrites.has(`vendor:${vendor.id}`))
								inventory.upsertVendor(vendor);
						}
					}
					inventory.upsertSpool(server);
					this.eventFullRefreshNeeded.delete(id);
				} else inventory.upsertSpool(withServerSpoolField(current, server, field));
				let fieldStillPending = false;
				for (const entry of uncertainties) {
					const pendingValues = inventory.pendingSpoolRenameValues(id, entry.field, entry.revision);
					if (pendingValues.some((value) => spoolHasFieldValue(server, entry.field, value))) {
						if (entry.field === field) fieldStillPending = true;
					} else {
						inventory.resolveSpoolUncertainty(id, entry.field, entry.revision);
					}
				}
				if (fieldStillPending) return false;
			} else {
				inventory.removeSpool(id);
				this.eventFullRefreshNeeded.delete(id);
			}
			if (inventory.spoolUncertainty(id, field) === undefined) return true;
		}
		console.warn(`Spool ${id} kept changing during rename reconciliation`);
		return false;
	}

	private async refreshRenamedSpools(ids: number[], field: GroupField): Promise<boolean> {
		if (!ids.length) return true;
		const controller = new AbortController();
		const timeout = Math.min(
			RENAME_REFRESH_MAX_TIMEOUT_MS,
			Math.max(
				RENAME_REFRESH_TIMEOUT_MS,
				Math.ceil(ids.length / RENAME_REFRESH_CONCURRENCY) * RENAME_REFRESH_WAVE_BUDGET_MS
			)
		);
		const timer = setTimeout(() => controller.abort(), timeout);
		let next = 0;
		let refreshed = true;
		try {
			const worker = async () => {
				while (next < ids.length) {
					if (controller.signal.aborted) {
						refreshed = false;
						return;
					}
					const id = ids[next++];
					try {
						if (!(await this.refreshRenamedSpool(id, field, controller.signal))) {
							refreshed = false;
						}
					} catch (error) {
						console.error('Failed to refresh spool %s after rename', id, error);
						refreshed = false;
					}
				}
			};
			await Promise.all(Array.from({ length: Math.min(ids.length, RENAME_REFRESH_CONCURRENCY) }, worker));
		} finally {
			clearTimeout(timer);
		}
		return refreshed;
	}

	async refreshUncertainSpools(ids: number[]): Promise<boolean> {
		const fields = new Set(ids.flatMap((id) => inventory.uncertainSpoolFields(id)));
		let refreshed = true;
		for (const field of fields) {
			const affected = ids.filter((id) => inventory.uncertainSpoolFields(id).includes(field));
			if (!(await this.refreshRenamedSpools(affected, field))) refreshed = false;
		}
		return refreshed;
	}

	private addRenameCandidates(ids: Iterable<number>) {
		for (const id of ids) {
			for (const active of this.activeRenames) {
				if (active.accepting && !active.candidates.has(id))
					active.candidates.set(id, inventory.markSpoolUncertain(id, active.field));
			}
		}
	}

	/**
	 * Replace one value of one spool field wherever it occurs, in a single request. Works for
	 * any field the spool owns, so the dashboard can rename a whole group without paging in its
	 * members — and without leaving out the ones it never loaded.
	 */
	async renameFieldValue(field: GroupField, value: string, newValue: string): Promise<SpoolRenameResult> {
		const inherited = new Set(inventory.uncertainSpoolIds());
		for (const active of this.activeRenames) for (const id of active.candidates.keys()) inherited.add(id);
		const active: ActiveRename = { field, value, candidates: new Map(), accepting: true };
		this.activeRenames.add(active);
		this.addRenameCandidates(inherited);
		const matching = () =>
			inventory.spools.filter((spool) => spoolHasFieldValue(spool, field, value)).map((spool) => spool.id);
		this.addRenameCandidates(matching());
		let sent = false;
		let rejected = false;
		try {
			// Release the write barrier after the PATCH, so later writes can settle
			// before reconciliation without waiting on the reconciliation itself.
			let updated: number;
			try {
				updated = await this.writeSpools(async () => {
					this.addRenameCandidates(matching());
					sent = true;
					this.spoolBulkRevision++;
					noteSpoolRename(field);
					inventory.spoolRenameRevision++;
					inventory.spoolRenamesInFlight++;
					let succeeded = false;
					try {
						const result = await patchJson<{ spools_updated: number }>(
							`/spool/field/${encodeURIComponent(field)}`,
							{
								value,
								new_value: newValue
							}
						);
						succeeded = true;
						return result.spools_updated;
					} catch (error) {
						// This endpoint validates these responses before executing the update.
						rejected = error instanceof HttpError && (error.status === 400 || error.status === 422);
						throw error;
					} finally {
						// Even a lost response may follow a committed PATCH. Fence every read
						// that overlapped the request and verify its candidates in either case.
						this.spoolBulkRevision++;
						noteSpoolRename(field);
						inventory.spoolRenameRevision++;
						inventory.spoolRenamesInFlight--;
						this.addRenameCandidates(matching());
						if (!succeeded && !rejected) {
							if (!this.ambiguousRenames.some((entry) => entry.field === field && entry.value === value))
								this.ambiguousRenames.push({ field, value });
							for (const [id, revision] of active.candidates)
								inventory.holdSpoolUncertainty(id, field, revision, value);
						}
						active.accepting = false;
					}
				});
			} catch (error) {
				if (sent && !rejected) {
					await this.refreshRenamedSpools([...active.candidates.keys()], field);
					throw new SpoolRenameUncertainError(error);
				}
				throw error;
			}
			return {
				updated,
				cacheRefreshed: await this.refreshRenamedSpools([...active.candidates.keys()], field)
			};
		} finally {
			this.activeRenames.delete(active);
			if (!sent || rejected) {
				const uncached: number[] = [];
				for (const [id, revision] of active.candidates) {
					if (inventory.spoolById(id)) inventory.cancelSpoolUncertainty(id, field, revision);
					else uncached.push(id);
				}
				// A list may already be displaying an uncached candidate. Keep it
				// quarantined until a full read supplies its spool and relations.
				void this.refreshRenamedSpools(uncached, field);
			}
		}
	}
	async lotNumbers(): Promise<string[]> {
		return getJson<string[]>('/lot-number');
	}
	async vendorNames(): Promise<string[]> {
		const vendors = await this.listVendors();
		// Vendor names aren't unique, and callers key their lists by name (#1306).
		return [...new Set(vendors.map((v) => v.name).filter(Boolean))];
	}
}

export const spoolSource = new HttpSpoolSource();
