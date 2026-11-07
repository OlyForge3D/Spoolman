import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config', () => ({ API_BASE: 'http://spoolman.test/api/v1' }));

import { inventory } from '$lib/stores/inventory.svelte';
import { fields } from '$lib/stores/fields.svelte';
import { FieldType, type FieldDef } from './fields';
import { mapSpool } from './map';
import { allPages } from './query';
import { readSpoolSnapshot } from './spoolReadFence';
import { SpoolBatchError, SpoolRenameUncertainError, spoolSource } from './spoolSource';
import { searchAll } from './search';
import { findTagHolder } from './tags';

// GET /location only knows locations that hold a spool, so an idle toolhead set up
// as a dashboard card could not be picked for a spool (#1261).

const setting = (value: unknown) => ({ value: JSON.stringify(value), is_set: true, type: 'object' });

function serve(locations: string[], settings: Record<string, unknown> | null) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			if (url.endsWith('/location')) return Response.json(locations);
			if (settings === null) return new Response('{}', { status: 500 });
			return Response.json(settings);
		})
	);
}

afterEach(() => vi.unstubAllGlobals());

describe('locationChoices', () => {
	it('adds the empty locations kept as dashboard cards', async () => {
		serve(['Shelf', 'Printer 1'], {
			dashboard_groups: setting({ location: ['Toolhead 1', 'Shelf', ''], material: ['PLA'] })
		});
		expect(await spoolSource.locationChoices()).toEqual(['Printer 1', 'Shelf', 'Toolhead 1']);
	});

	it("reads the old client's saved locations when the dashboard has none", async () => {
		serve(['Shelf'], { locations: setting(['Toolhead 2']) });
		expect(await spoolSource.locationChoices()).toEqual(['Shelf', 'Toolhead 2']);
	});

	it('still offers the locations in use when settings fail to load', async () => {
		serve(['Shelf'], null);
		expect(await spoolSource.locationChoices()).toEqual(['Shelf']);
	});
});

describe('importExternalFilament', () => {
	const ext = {
		id: 'Prusa_PLA',
		manufacturer: 'Prusa',
		name: 'PLA',
		material: 'PLA',
		density: 1.24,
		diameter: 1.75,
		weight: 1000
	};
	type ApiVendor = { id: number; name: string; external_id?: string };

	beforeEach(() => {
		vi.spyOn(fields, 'isLoaded').mockReturnValue(true);
		vi.spyOn(fields, 'get').mockReturnValue([]);
	});
	afterEach(() => vi.restoreAllMocks());

	function serveImport(vendors: ApiVendor[], filamentIds: string[] = []) {
		const fetch = vi.fn(async (url: string, init?: RequestInit) => {
			const parsed = new URL(url);
			const resource = parsed.pathname.split('/').pop();
			if (init?.method === 'POST') {
				const body = JSON.parse(init.body as string);
				if (resource === 'vendor') {
					const vendor = { id: 100, ...body };
					vendors.push(vendor);
					return Response.json(vendor);
				}
				return Response.json({ id: 200, ...body, vendor: vendors.find((v) => v.id === body.vendor_id) });
			}
			const rows =
				resource === 'vendor' ? vendors : filamentIds.map((external_id, i) => ({ id: i + 1, external_id }));
			const term = parsed.searchParams.get('external_id');
			if (term === null) return Response.json(rows);
			return Response.json(
				rows.filter((row) =>
					term.startsWith('"') && term.endsWith('"')
						? row.external_id === term.slice(1, -1)
						: row.external_id?.toLowerCase().includes(term.toLowerCase())
				)
			);
		});
		vi.stubGlobal('fetch', fetch);
		return fetch;
	}

	it('reuses a hand-made vendor with the same name in different case without editing it', async () => {
		const vendor = { id: 10, name: 'pRUSA' };
		const fetch = serveImport([vendor]);
		expect((await spoolSource.importExternalFilament(ext)).vendorId).toBe('10');
		expect(vendor).toEqual({ id: 10, name: 'pRUSA' });
		expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
		expect(fetch.mock.calls.every(([, init]) => !['PATCH', 'PUT'].includes(init?.method ?? ''))).toBe(true);
	});

	it('prefers an exact external_id over a matching name', async () => {
		const fetch = serveImport([
			{ id: 10, name: 'Prusa' },
			{ id: 20, name: 'Renamed manufacturer', external_id: 'Prusa' }
		]);
		expect((await spoolSource.importExternalFilament(ext)).vendorId).toBe('20');
		expect(fetch.mock.calls.map(([url]) => new URL(url).searchParams.get('external_id'))).toEqual([
			'"Prusa_PLA"',
			'"Prusa"',
			null
		]);
	});

	it('does not reuse substring external_ids for vendors or filaments', async () => {
		const vendors = [{ id: 10, name: 'Prusament', external_id: 'Prusament' }];
		const fetch = serveImport(vendors, ['Prusa_PLA_Plus']);
		const imported = await spoolSource.importExternalFilament(ext);
		expect(imported.id).toBe('200');
		expect(imported.vendorId).toBe('100');
		expect(vendors[1]).toEqual({ id: 100, name: 'Prusa', external_id: 'Prusa' });
		expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
	});

	it('returns an already imported filament without creating anything', async () => {
		vi.mocked(fields.isLoaded).mockReturnValue(false);
		const load = vi.spyOn(fields, 'loadRequired');
		const fetch = serveImport([], [ext.id]);
		expect((await spoolSource.importExternalFilament(ext)).id).toBe('1');
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(new URL(fetch.mock.calls[0][0]).searchParams.get('external_id')).toBe('"Prusa_PLA"');
		expect(load).not.toHaveBeenCalled();
	});

	it('applies defaults only to the new filament and manufacturer', async () => {
		const definitions = (entity: 'filament' | 'vendor'): FieldDef[] => [
			{
				key: `${entity}_default`,
				name: 'Default',
				order: 0,
				field_type: FieldType.text,
				entity_type: entity,
				default_value: `"${entity} value"`
			}
		];
		vi.mocked(fields.get).mockImplementation((entity) => (entity === 'spool' ? [] : definitions(entity)));
		const fetch = serveImport([]);
		await spoolSource.importExternalFilament(ext);
		const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
		expect(JSON.parse(posts[0][1]!.body as string).extra).toEqual({ vendor_default: '"vendor value"' });
		expect(JSON.parse(posts[1][1]!.body as string).extra).toEqual({ filament_default: '"filament value"' });
	});

	it('does not load or apply manufacturer defaults when a name already matches', async () => {
		const get = vi.mocked(fields.get);
		const fetch = serveImport([{ id: 10, name: 'Prusa' }]);
		await spoolSource.importExternalFilament(ext);
		expect(get).toHaveBeenCalledWith('filament');
		expect(get).not.toHaveBeenCalledWith('vendor');
		expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
	});

	it.each(['filament', 'vendor'] as const)(
		'does not create records when %s definitions cannot be loaded',
		async (failed) => {
			vi.mocked(fields.isLoaded).mockImplementation((entity) => entity !== failed);
			vi.spyOn(fields, 'loadRequired').mockRejectedValue(new Error('definitions unavailable'));
			const fetch = serveImport([]);
			await expect(spoolSource.importExternalFilament(ext)).rejects.toThrow('definitions unavailable');
			expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
		}
	);
});

describe('createFilament', () => {
	it.each([undefined, 0, 0.5])('sends optional numeric values unchanged: %s', async (value) => {
		const fetch = vi.fn(async (_url: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string);
			expect(body.spool_weight).toBe(value);
			expect(body.price).toBe(value);
			expect(body.settings_extruder_temp).toBe(value);
			expect(body.settings_bed_temp).toBe(value);
			return Response.json({ id: 1, ...body });
		});
		vi.stubGlobal('fetch', fetch);
		await spoolSource.createFilament({
			name: 'Test',
			vendorName: '',
			material: 'PLA',
			density: 1.24,
			diameter: 1.75,
			colors: [],
			spoolWeight: value,
			price: value,
			nozzleTemp: value,
			bedTemp: value
		});
		expect(fetch).toHaveBeenCalledOnce();
	});
});

describe('staged spool pages', () => {
	it('does not alter the inventory until the page is committed', async () => {
		const id = 88001;
		inventory.removeSpool(id);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json([{ id, location: 'Shelf', filament: { id: 88001, vendor: { id: 88001 } } }])
			)
		);
		const page = await spoolSource.stageSpools({
			filters: {},
			sort: [],
			limit: 30,
			offset: 0,
			lowThreshold: 0
		});
		expect(page.items[0].id).toBe(id);
		expect(inventory.spoolById(id)).toBeUndefined();
		expect(inventory.filamentById('88001')).toBeUndefined();
		page.commit();
		expect(inventory.spoolById(id)).toEqual(page.items[0]);
		expect(inventory.filamentById('88001')).toBeDefined();
		expect(inventory.vendorById('88001')).toBeDefined();
	});
});

describe('listFilamentPage', () => {
	it.each(['asc', 'desc'] as const)(
		'requests a bounded page in %s order and caches its relations',
		async (dir) => {
			const fetch = vi.fn(async () =>
				Response.json([{ id: 1201, name: 'Page filament', vendor: { id: 1201, name: 'Page vendor' } }], {
					headers: { 'X-Total-Count': '1500' }
				})
			);
			vi.stubGlobal('fetch', fetch);
			const signal = new AbortController().signal;
			const page = await spoolSource.listFilamentPage({
				sort: [{ field: 'id', dir }],
				limit: 100,
				offset: 100,
				signal
			});
			expect(fetch).toHaveBeenCalledExactlyOnceWith(
				`http://spoolman.test/api/v1/filament?sort=id%3A${dir}&limit=100&offset=100`,
				{ signal }
			);
			expect(page.total).toBe(1500);
			expect(page.items.map((f) => f.id)).toEqual(['1201']);
			expect(inventory.filamentById('1201')).toEqual(page.items[0]);
			expect(inventory.vendorById('1201')?.name).toBe('Page vendor');
		}
	);

	it('keeps the preview batch API returning an array', async () => {
		const fetch = vi.fn(async () => Response.json([{ id: 1, name: 'Preview' }]));
		vi.stubGlobal('fetch', fetch);
		expect((await spoolSource.listFilaments(8)).map((f) => f.id)).toEqual(['1']);
		expect(fetch).toHaveBeenCalledExactlyOnceWith(
			'http://spoolman.test/api/v1/filament?sort=id%3Adesc&limit=8&offset=0',
			{ signal: undefined }
		);
	});
});

describe('vendorNames', () => {
	it('lists a name shared by two vendors once', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json([
					{ id: 1, name: 'Polymaker', registered: '2024-01-01T00:00:00Z', extra: {} },
					{ id: 2, name: 'Polymaker', registered: '2024-01-01T00:00:00Z', extra: {} },
					{ id: 3, name: 'Prusament', registered: '2024-01-01T00:00:00Z', extra: {} }
				])
			)
		);
		expect(await spoolSource.vendorNames()).toEqual(['Polymaker', 'Prusament']);
	});
});

describe('entity write ordering', () => {
	beforeEach(() => {
		for (const spool of inventory.spools) inventory.removeSpool(spool.id);
	});

	function controlledFetch() {
		const requests: { url: string; init?: RequestInit; respond: (response: Response) => void }[] = [];
		const fetch = vi.fn(
			(url: string, init?: RequestInit) =>
				new Promise<Response>((respond) => requests.push({ url, init, respond }))
		);
		vi.stubGlobal('fetch', fetch);
		return { fetch, requests };
	}

	it('re-reads a list response that returns after a completed rename', async () => {
		const { fetch, requests } = controlledFetch();
		inventory.upsertSpool(mapSpool({ id: 88002, location: 'Shelf' }));
		const list = spoolSource.listSpools({ filters: {}, sort: [], limit: 30, offset: 0, lowThreshold: 0 });
		const rename = spoolSource.renameFieldValue('location', 'Shelf', 'Desk');
		requests[1].respond(Response.json({ spools_updated: 1 }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
		requests[2].respond(Response.json({ id: 88002, location: 'Desk' }));
		await rename;
		requests[0].respond(Response.json([{ id: 88002, location: 'Shelf' }]));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
		expect(inventory.spoolById(88002)?.location).toBe('Desk');
		requests[3].respond(Response.json([{ id: 88002, location: 'Desk' }]));
		expect((await list).items[0].location).toBe('Desk');
		expect(inventory.spoolById(88002)?.location).toBe('Desk');
	});

	it('re-reads group aggregates that return after a rename', async () => {
		const { fetch, requests } = controlledFetch();
		const groups = spoolSource.listGroups({
			field: 'location',
			filters: {},
			sort: [],
			limit: 30,
			offset: 0,
			lowThreshold: 0
		});
		const rename = spoolSource.renameFieldValue('location', 'Group fence old', 'Group fence new');
		requests[1].respond(Response.json({ spools_updated: 0 }));
		await rename;
		requests[0].respond(Response.json([{ group_by: 'location', key: 'Group fence old', spool_count: 1 }]));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
		requests[2].respond(Response.json([{ group_by: 'location', key: 'Group fence new', spool_count: 1 }]));
		expect((await groups).items.map((group) => group.key)).toEqual(['Group fence new']);
	});

	it('re-reads all group pages when a rename falls between pages', async () => {
		const { fetch, requests } = controlledFetch();
		const query = {
			field: 'location' as const,
			filters: {},
			sort: [],
			limit: 1,
			lowThreshold: 0
		};
		const groups = readSpoolSnapshot(
			() => allPages(1, (offset) => spoolSource.listGroups({ ...query, offset })),
			(items) => items
		);
		const page = (key: string) =>
			Response.json([{ group_by: 'location', key, spool_count: 1 }], {
				headers: { 'x-total-count': '2' }
			});
		requests[0].respond(page('First group'));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		const rename = spoolSource.renameFieldValue('location', 'Paged old', 'Paged new');
		requests[2].respond(Response.json({ spools_updated: 0 }));
		await rename;
		requests[1].respond(page('Paged old'));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
		requests[3].respond(page('Paged new'));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
		requests[4].respond(page('First group'));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(6));
		requests[5].respond(page('Paged new'));
		expect((await groups).map((group) => group.key)).toEqual(['First group', 'Paged new']);
	});

	it('quarantines a newly cached matching spool before an in-flight rename settles', async () => {
		const { fetch, requests } = controlledFetch();
		const id = 88006;
		const rename = spoolSource.renameFieldValue('location', 'Shelf', 'Desk');
		const list = spoolSource.listSpools({ filters: {}, sort: [], limit: 30, offset: 0, lowThreshold: 0 });
		requests[1].respond(Response.json([{ id, location: 'Shelf' }]));
		await list;
		expect(inventory.spoolById(id)?.location).toBe('Shelf');
		expect(inventory.isSpoolUncertain(id)).toBe(true);

		requests[0].respond(Response.json({ spools_updated: 1 }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
		requests[2].respond(Response.json({ id, location: 'Desk' }));
		expect(await rename).toEqual({ updated: 1, cacheRefreshed: true });
		expect(inventory.spoolById(id)?.location).toBe('Desk');
		expect(inventory.isSpoolUncertain(id)).toBe(false);
	});

	it('quarantines a newly seen event while a rename request is in flight', async () => {
		const id = 88007;
		let resolvePatch: (response: Response) => void = () => {};
		const patch = new Promise<Response>((resolve) => (resolvePatch = resolve));
		const fetch = vi.fn((url: string, init?: RequestInit) =>
			init?.method === 'PATCH' ? patch : Promise.resolve(Response.json({ id, location: 'Desk' }))
		);
		vi.stubGlobal('fetch', fetch);
		const rename = spoolSource.renameFieldValue('location', 'Shelf', 'Desk');
		spoolSource.ingestLiveEvent({
			resource: 'spool',
			type: 'updated',
			id,
			payload: { id, location: 'Shelf' }
		});
		expect(inventory.isSpoolUncertain(id)).toBe(true);
		expect(fetch).toHaveBeenCalledOnce();
		resolvePatch(Response.json({ spools_updated: 1 }));
		await rename;
		await vi.waitFor(() => expect(inventory.isSpoolUncertain(id)).toBe(false));
		expect(inventory.spoolById(id)?.location).toBe('Desk');
	});

	it('keeps an ambiguous rename quarantined and fences older reads until retried', async () => {
		const { fetch, requests } = controlledFetch();
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const id = 88008;
		try {
			inventory.upsertSpool(mapSpool({ id, location: 'Ambiguous shelf A' }));
			const list = spoolSource.listSpools({ filters: {}, sort: [], limit: 30, offset: 0, lowThreshold: 0 });
			const rename = spoolSource.renameFieldValue('location', 'Ambiguous shelf A', 'Ambiguous desk B');
			const failure = expect(rename).rejects.toBeInstanceOf(SpoolRenameUncertainError);
			// A gateway error could arrive after the server committed the PATCH.
			requests[1].respond(new Response('{}', { status: 503 }));
			await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
			requests[2].respond(new Response('{}', { status: 503 }));
			await failure;
			expect(inventory.isSpoolUncertain(id)).toBe(true);

			requests[0].respond(Response.json([{ id, location: 'Ambiguous shelf A' }]));
			await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
			requests[3].respond(Response.json([{ id, location: 'Ambiguous desk B' }]));
			await list;
			expect(inventory.isSpoolUncertain(id)).toBe(true);
			const retry = spoolSource.refreshUncertainSpools([id]);
			await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
			requests[4].respond(Response.json({ id, location: 'Ambiguous desk B' }));
			expect(await retry).toBe(true);
			expect(inventory.spoolById(id)?.location).toBe('Ambiguous desk B');
			expect(inventory.isSpoolUncertain(id)).toBe(false);
		} finally {
			log.mockRestore();
		}
	});

	it('does not trust an old value while an ambiguous rename could still commit', async () => {
		const { fetch, requests } = controlledFetch();
		const id = 88009;
		const lateId = 88010;
		inventory.upsertSpool(mapSpool({ id, location: 'Unconfirmed A' }));
		const rename = spoolSource.renameFieldValue('location', 'Unconfirmed A', 'Unconfirmed B');
		const failure = expect(rename).rejects.toBeInstanceOf(SpoolRenameUncertainError);
		requests[0].respond(new Response('{}', { status: 503 }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		requests[1].respond(Response.json({ id, location: 'Unconfirmed A' }));
		await failure;
		expect(inventory.isSpoolUncertain(id)).toBe(true);

		// A later list can discover a spool that the still-running PATCH may affect.
		const list = spoolSource.listSpools({ filters: {}, sort: [], limit: 30, offset: 0, lowThreshold: 0 });
		requests[2].respond(Response.json([{ id: lateId, location: 'Unconfirmed A' }]));
		await list;
		expect(inventory.isSpoolUncertain(lateId)).toBe(true);

		const retry = spoolSource.refreshUncertainSpools([id, lateId]);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
		requests[3].respond(Response.json({ id, location: 'Unconfirmed B' }));
		requests[4].respond(Response.json({ id: lateId, location: 'Unconfirmed B' }));
		expect(await retry).toBe(true);
		expect(inventory.isSpoolUncertain(id)).toBe(false);
		expect(inventory.isSpoolUncertain(lateId)).toBe(false);
	});

	it.each([400, 422])('releases candidates after a definite validation rejection: %s', async (status) => {
		const { fetch, requests } = controlledFetch();
		const id = 88011;
		inventory.upsertSpool(mapSpool({ id, location: 'Invalid rename' }));
		const rename = spoolSource.renameFieldValue('location', 'Invalid rename', 'Other');
		const failure = expect(rename).rejects.toMatchObject({ status });
		expect(inventory.isSpoolUncertain(id)).toBe(true);
		requests[0].respond(new Response('{}', { status }));
		await failure;
		expect(fetch).toHaveBeenCalledOnce();
		expect(inventory.isSpoolUncertain(id)).toBe(false);
	});

	it('rejects a staged page that became stale before commit', async () => {
		const { fetch, requests } = controlledFetch();
		inventory.upsertSpool(mapSpool({ id: 88003, location: 'Shelf' }));
		const staging = spoolSource.stageSpools({ filters: {}, sort: [], limit: 30, offset: 0, lowThreshold: 0 });
		requests[0].respond(Response.json([{ id: 88003, location: 'Shelf' }]));
		const page = await staging;
		const rename = spoolSource.renameFieldValue('location', 'Shelf', 'Desk');
		requests[1].respond(Response.json({ spools_updated: 1 }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
		requests[2].respond(Response.json({ id: 88003, location: 'Desk' }));
		await rename;
		expect(page.isCurrent()).toBe(false);
		expect(page.commit()).toBe(false);
		expect(inventory.spoolById(88003)?.location).toBe('Desk');
	});

	it.each(['fetch', 'search', 'tag'] as const)(
		're-reads a stale %s response instead of overwriting reconciled cache',
		async (kind) => {
			const { fetch, requests } = controlledFetch();
			const id = 88004;
			inventory.upsertSpool(mapSpool({ id, location: 'Shelf' }));
			const read =
				kind === 'fetch'
					? spoolSource.fetchSpool(id)
					: kind === 'search'
						? searchAll('test', 20)
						: findTagHolder('aabb');
			const readCount = kind === 'tag' ? 2 : 1;
			const rename = spoolSource.renameFieldValue('location', 'Shelf', 'Desk');
			requests[readCount].respond(Response.json({ spools_updated: 1 }));
			await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(readCount + 2));
			requests[readCount + 1].respond(Response.json({ id, location: 'Desk' }));
			await rename;
			const response = (location: string) =>
				kind === 'search'
					? Response.json({ spools: [{ spool: { id, location }, match_field: 'location' }] })
					: kind === 'tag'
						? Response.json([{ id, location }])
						: Response.json({ id, location });
			requests[0].respond(response('Shelf'));
			if (kind === 'tag') requests[1].respond(Response.json([]));
			await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(readCount * 2 + 2));
			expect(inventory.spoolById(id)?.location).toBe('Desk');
			requests[readCount + 2].respond(response('Desk'));
			if (kind === 'tag') requests[readCount + 3].respond(Response.json([]));
			await read;
			expect(inventory.spoolById(id)?.location).toBe('Desk');
		}
	);

	it.each(['live', 'scan'] as const)(
		'quarantines and verifies a potentially stale %s event after a rename',
		async (kind) => {
			const { fetch, requests } = controlledFetch();
			const id = 88005;
			inventory.upsertSpool(mapSpool({ id, location: 'Shelf' }));
			const rename = spoolSource.renameFieldValue('location', 'Shelf', 'Desk');
			requests[0].respond(Response.json({ spools_updated: 1 }));
			await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
			requests[1].respond(Response.json({ id, location: 'Desk' }));
			await rename;
			if (kind === 'live')
				spoolSource.ingestLiveEvent({
					resource: 'spool',
					type: 'updated',
					id,
					payload: { id, location: 'Earlier location' }
				});
			else spoolSource.ingestScannedSpool(mapSpool({ id, location: 'Earlier location' }));
			expect(inventory.isSpoolUncertain(id)).toBe(true);
			await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
			requests[2].respond(Response.json({ id, location: 'Desk' }));
			await vi.waitFor(() => expect(inventory.isSpoolUncertain(id)).toBe(false));
			expect(inventory.spoolById(id)?.location).toBe('Desk');
		}
	);

	it('bounds authoritative event refreshes during a burst', async () => {
		const requests: { id: number; respond: () => void }[] = [];
		let inFlight = 0;
		let maximum = 0;
		const fetch = vi.fn((url: string, init?: RequestInit) => {
			if (init?.method === 'PATCH') return Promise.resolve(Response.json({ spools_updated: 0 }));
			const id = Number(url.split('/').at(-1));
			inFlight++;
			maximum = Math.max(maximum, inFlight);
			return new Promise<Response>((resolve) =>
				requests.push({
					id,
					respond: () => {
						inFlight--;
						resolve(Response.json({ id, location: 'Current burst location' }));
					}
				})
			);
		});
		vi.stubGlobal('fetch', fetch);
		await spoolSource.renameFieldValue('location', 'Burst old', 'Burst new');
		const ids = Array.from({ length: 10 }, (_, index) => 88100 + index);
		for (const id of ids)
			spoolSource.ingestLiveEvent({
				resource: 'spool',
				type: 'updated',
				id,
				payload: { id, location: 'Earlier burst location' }
			});
		await vi.waitFor(() => expect(requests).toHaveLength(4));
		for (let i = 0; i < ids.length; i++) {
			await vi.waitFor(() => expect(requests.length).toBeGreaterThan(i));
			requests[i].respond();
		}
		await vi.waitFor(() => expect(ids.every((id) => !inventory.isSpoolUncertain(id))).toBe(true));
		expect(maximum).toBe(4);
	});

	it('serializes writes for the same entity while allowing other entities to proceed', async () => {
		const { fetch, requests } = controlledFetch();
		const first = spoolSource.saveFilament('9001', { name: 'first' });
		const second = spoolSource.saveFilament('9001', { name: 'second' });
		const other = spoolSource.saveFilament('9002', { name: 'other' });
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(requests.map((request) => request.url)).toEqual([
			'http://spoolman.test/api/v1/filament/9001',
			'http://spoolman.test/api/v1/filament/9002'
		]);

		requests[1].respond(Response.json({ id: 9002, name: 'other' }));
		await other;
		requests[0].respond(Response.json({ id: 9001, name: 'first' }));
		await first;
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
		expect(JSON.parse(requests[2].init?.body as string)).toEqual({ name: 'second' });
		requests[2].respond(Response.json({ id: 9001, name: 'second' }));
		await second;
		expect(inventory.filamentById('9001')?.name).toBe('second');
	});

	it('reports a failed write and still runs the next queued write', async () => {
		const { fetch, requests } = controlledFetch();
		const first = spoolSource.saveVendor('9003', { name: 'first' });
		const failure = expect(first).rejects.toMatchObject({ status: 500 });
		const second = spoolSource.saveVendor('9003', { name: 'second' });
		expect(fetch).toHaveBeenCalledOnce();

		requests[0].respond(new Response('{}', { status: 500 }));
		await failure;
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		requests[1].respond(Response.json({ id: 9003, name: 'second' }));
		await second;
		expect(inventory.vendorById('9003')?.name).toBe('second');
	});

	it('waits for an in-flight spool edit before deleting the spool', async () => {
		const { fetch, requests } = controlledFetch();
		const save = spoolSource.saveSpool(9004, { lot: 'updated' });
		const deletion = spoolSource.deleteSpool(9004);
		expect(fetch).toHaveBeenCalledOnce();

		requests[0].respond(Response.json({ id: 9004, lot_nr: 'updated' }));
		await save;
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		expect(requests[1].init?.method).toBe('DELETE');
		requests[1].respond(new Response(null, { status: 204 }));
		await deletion;
		expect(inventory.spoolById(9004)).toBeUndefined();
	});

	it.each([
		{
			name: 'length',
			write: (id: number) => spoolSource.useSpoolLength(id, 20),
			path: '/use',
			body: { use_length: 20 }
		},
		{
			name: 'weight',
			write: (id: number) => spoolSource.useSpoolWeight(id, 30),
			path: '/use',
			body: { use_weight: 30 }
		},
		{
			name: 'measurement',
			write: (id: number) => spoolSource.measureSpool(id, 40),
			path: '/measure',
			body: { weight: 40 }
		}
	])('orders a spool $name operation after a pending edit', async ({ write, path, body }) => {
		const { fetch, requests } = controlledFetch();
		const save = spoolSource.saveSpool(9005, { lot: 'updated' });
		const adjustment = write(9005);
		expect(fetch).toHaveBeenCalledOnce();
		requests[0].respond(Response.json({ id: 9005, lot_nr: 'updated' }));
		await save;

		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		expect(requests[1].url).toBe(`http://spoolman.test/api/v1/spool/9005${path}`);
		expect(requests[1].init?.method).toBe('PUT');
		expect(JSON.parse(requests[1].init?.body as string)).toEqual(body);
		requests[1].respond(Response.json({ id: 9005, lot_nr: 'updated' }));
		expect((await adjustment).lot).toBe('updated');
	});

	it('orders bulk renames between earlier and later spool writes', async () => {
		const { fetch, requests } = controlledFetch();
		const first = spoolSource.saveSpool(9006, { location: 'Shelf' });
		const move = spoolSource.saveSpool(9006, { location: 'Printer' });
		const rename = spoolSource.renameFieldValue('location', 'Printer', 'Office');
		const later = spoolSource.saveSpool(9007, { location: 'Office' });
		const other = spoolSource.saveVendor('9008', { name: 'independent' });
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(requests[1].url).toContain('/vendor/9008');
		requests[1].respond(Response.json({ id: 9008, name: 'independent' }));
		await other;

		requests[0].respond(Response.json({ id: 9006, location: 'Shelf' }));
		await first;
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
		expect(JSON.parse(requests[2].init?.body as string)).toEqual({ location: 'Printer' });
		requests[2].respond(Response.json({ id: 9006, location: 'Printer' }));
		await move;
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
		expect(requests[3].url).toContain('/spool/field/location');
		requests[3].respond(Response.json({ spools_updated: 1 }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(6));
		const refresh = requests.find(({ url }, index) => index > 3 && url.endsWith('/spool/9006'));
		const laterWrite = requests.find(({ url }) => url.endsWith('/spool/9007'));
		if (!refresh || !laterWrite) throw new Error('Expected the rename refresh and later write');
		refresh.respond(Response.json({ id: 9006, location: 'Office' }));
		laterWrite.respond(Response.json({ id: 9007, location: 'Office' }));
		expect(await rename).toEqual({ updated: 1, cacheRefreshed: true });
		await later;
	});

	it('reports a blocked write without sending it after the wait expires', async () => {
		vi.useFakeTimers();
		const { fetch, requests } = controlledFetch();
		try {
			const first = spoolSource.saveSpool(9009, { location: 'Shelf' });
			const blocked = spoolSource.saveSpool(9009, { location: 'Printer' });
			const failure = expect(blocked).rejects.toThrow('An earlier write is still pending');
			await vi.advanceTimersByTimeAsync(30_000);
			await failure;
			expect(fetch).toHaveBeenCalledOnce();

			const retry = spoolSource.saveSpool(9009, { location: 'Printer' });
			await vi.advanceTimersByTimeAsync(0);
			expect(fetch).toHaveBeenCalledOnce();
			requests[0].respond(Response.json({ id: 9009, location: 'Shelf' }));
			await first;
			await vi.advanceTimersByTimeAsync(0);
			expect(fetch).toHaveBeenCalledTimes(2);
			requests[1].respond(Response.json({ id: 9009, location: 'Printer' }));
			await retry;
		} finally {
			vi.useRealTimers();
		}
	});

	it('releases an expired bulk barrier without overtaking the same spool', async () => {
		vi.useFakeTimers();
		const { fetch, requests } = controlledFetch();
		try {
			const first = spoolSource.saveSpool(9010, { location: 'Shelf' });
			const rename = spoolSource.renameFieldValue('location', 'Shelf', 'Office');
			const failure = expect(rename).rejects.toThrow('An earlier write is still pending');
			await vi.advanceTimersByTimeAsync(30_000);
			await failure;

			const other = spoolSource.saveSpool(9011, { location: 'Printer' });
			const same = spoolSource.saveSpool(9010, { location: 'Printer' });
			await vi.advanceTimersByTimeAsync(0);
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(requests[1].url).toContain('/spool/9011');
			requests[1].respond(Response.json({ id: 9011, location: 'Printer' }));
			await other;

			requests[0].respond(Response.json({ id: 9010, location: 'Shelf' }));
			await first;
			await vi.advanceTimersByTimeAsync(0);
			expect(fetch).toHaveBeenCalledTimes(3);
			expect(requests[2].url).toContain('/spool/9010');
			requests[2].respond(Response.json({ id: 9010, location: 'Printer' }));
			await same;
			expect(requests.every(({ url }) => !url.includes('/spool/field/'))).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('unblocks an unrelated write that was already waiting when a bulk rename expires', async () => {
		vi.useFakeTimers();
		const { fetch, requests } = controlledFetch();
		try {
			const first = spoolSource.saveSpool(9016, { location: 'Shelf' });
			const rename = spoolSource.renameFieldValue('location', 'Shelf', 'Office');
			const failure = expect(rename).rejects.toThrow('An earlier write is still pending');
			await vi.advanceTimersByTimeAsync(10_000);
			const other = spoolSource.saveSpool(9017, { location: 'Printer' });
			await vi.advanceTimersByTimeAsync(20_000);
			await failure;
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(requests[1].url).toContain('/spool/9017');
			requests[1].respond(Response.json({ id: 9017, location: 'Printer' }));
			await other;
			requests[0].respond(Response.json({ id: 9016, location: 'Shelf' }));
			await first;
			await vi.advanceTimersByTimeAsync(0);
			expect(fetch).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps an earlier bulk write as a barrier when a later rename expires', async () => {
		vi.useFakeTimers();
		const { fetch, requests } = controlledFetch();
		try {
			const first = spoolSource.renameFieldValue('location', 'Shelf', 'Office');
			const expired = spoolSource.renameFieldValue('location', 'Office', 'Desk');
			const failure = expect(expired).rejects.toThrow('An earlier write is still pending');
			await vi.advanceTimersByTimeAsync(10_000);
			const alreadyWaiting = spoolSource.createSpool({ filament_id: 1, location: 'Shelf' });
			await vi.advanceTimersByTimeAsync(20_000);
			await failure;

			const later = spoolSource.saveSpool(9021, { location: 'Shelf' });
			await vi.advanceTimersByTimeAsync(0);
			expect(fetch).toHaveBeenCalledOnce();
			requests[0].respond(Response.json({ spools_updated: 0 }));
			await first;
			await vi.advanceTimersByTimeAsync(0);
			expect(fetch).toHaveBeenCalledTimes(3);
			expect(requests[1].url).toMatch(/\/spool$/);
			expect(requests[2].url).toContain('/spool/9021');
			requests[1].respond(Response.json({ id: 9022, location: 'Shelf' }));
			requests[2].respond(Response.json({ id: 9021, location: 'Shelf' }));
			await Promise.all([alreadyWaiting, later]);
			expect(requests.filter(({ url }) => url.includes('/spool/field/'))).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('orders spool creation on both sides of a bulk rename', async () => {
		const { fetch, requests } = controlledFetch();
		const before = spoolSource.createSpool({ filament_id: 1, location: 'Shelf' });
		const rename = spoolSource.renameFieldValue('location', 'Shelf', 'Office');
		const after = spoolSource.createSpool({ filament_id: 1, location: 'Shelf' });
		expect(fetch).toHaveBeenCalledOnce();
		requests[0].respond(Response.json({ id: 9012, location: 'Shelf' }));
		await before;
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		expect(requests[1].url).toContain('/spool/field/location');
		requests[1].respond(Response.json({ spools_updated: 1 }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
		const refresh = requests.find(({ url }) => url.endsWith('/spool/9012'));
		const creation = requests.find(({ init }, index) => index > 1 && init?.method === 'POST');
		if (!refresh || !creation) throw new Error('Expected both the rename refresh and later creation');
		refresh.respond(Response.json({ id: 9012, location: 'Office' }));
		creation.respond(Response.json({ id: 9013, location: 'Shelf' }));
		await Promise.all([rename, after]);
		expect(inventory.spoolById(9012)?.location).toBe('Office');
		expect(inventory.spoolById(9013)?.location).toBe('Shelf');
	});

	it('updates every matching cached spool after an extra-field rename', async () => {
		const { requests, fetch } = controlledFetch();
		inventory.upsertSpool(mapSpool({ id: 9014, extra: { printer: '"Rack \\"A\\""' } }));
		inventory.upsertSpool(mapSpool({ id: 9015, extra: { printer: '"Other"' } }));
		inventory.upsertSpool(mapSpool({ id: 9020, extra: { printer: '"Rack \\"A\\""', note: '"keep"' } }));
		const rename = spoolSource.renameFieldValue('extra.printer', 'Rack "A"', 'Office');
		requests[0].respond(Response.json({ spools_updated: 2 }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
		requests[1].respond(Response.json({ id: 9014, extra: { printer: '"Office"' } }));
		requests[2].respond(Response.json({ id: 9020, extra: { printer: '"Office"', note: '"keep"' } }));
		await rename;
		expect(inventory.spoolById(9014)?.extra.printer).toBe('"Office"');
		expect(inventory.spoolById(9015)?.extra.printer).toBe('"Other"');
		expect(inventory.spoolById(9020)?.extra).toEqual({ printer: '"Office"', note: '"keep"' });
	});

	it('refreshes an unchanged stale cache entry even when no server spools were renamed', async () => {
		const { requests, fetch } = controlledFetch();
		inventory.upsertSpool(mapSpool({ id: 9099, location: 'Race A' }));
		const rename = spoolSource.renameFieldValue('location', 'Race A', 'Race B');
		requests[0].respond(Response.json({ spools_updated: 0 }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		requests[1].respond(Response.json({ id: 9099, location: 'Race C' }));
		expect(await rename).toEqual({ updated: 0, cacheRefreshed: true });
		expect(inventory.spoolById(9099)?.location).toBe('Race C');
	});

	it.each([
		{ name: 'before', serverLocation: 'Race B' },
		{ name: 'after', serverLocation: 'Race A' }
	])('refreshes a live update made $name the server rename', async ({ serverLocation }) => {
		const { requests, fetch } = controlledFetch();
		inventory.upsertSpool(mapSpool({ id: 9100, location: 'Race X' }));
		const rename = spoolSource.renameFieldValue('location', 'Race A', 'Race B');
		inventory.upsertSpool(mapSpool({ id: 9100, location: 'Race A' }));
		requests[0].respond(Response.json({ spools_updated: 1 }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		expect(requests[1].url).toMatch(/\/spool\/9100$/);
		requests[1].respond(Response.json({ id: 9100, location: serverLocation }));
		expect(await rename).toEqual({ updated: 1, cacheRefreshed: true });
		expect(inventory.spoolById(9100)?.location).toBe(serverLocation);
	});

	it('retries reconciliation when a newer event arrives during the refresh', async () => {
		const { requests, fetch } = controlledFetch();
		inventory.upsertSpool(mapSpool({ id: 9101, location: 'Race X' }));
		const rename = spoolSource.renameFieldValue('location', 'Race A', 'Race B');
		inventory.upsertSpool(mapSpool({ id: 9101, location: 'Race A' }));
		requests[0].respond(Response.json({ spools_updated: 1 }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		inventory.upsertSpool(mapSpool({ id: 9101, location: 'Race C' }));
		requests[1].respond(Response.json({ id: 9101, location: 'Race B' }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
		requests[2].respond(Response.json({ id: 9101, location: 'Race C' }));
		expect((await rename).cacheRefreshed).toBe(true);
		expect(inventory.spoolById(9101)?.location).toBe('Race C');
	});

	it('does not overwrite an optimistic write queued after the rename', async () => {
		const { requests, fetch } = controlledFetch();
		inventory.upsertSpool(mapSpool({ id: 9102, location: 'Race X' }));
		const rename = spoolSource.renameFieldValue('location', 'Race A', 'Race B');
		inventory.patchSpool(9102, { location: 'Race A' });
		const later = spoolSource.saveSpool(9102, { location: 'Race A' });
		requests[0].respond(Response.json({ spools_updated: 0 }));
		expect(inventory.spoolById(9102)?.location).toBe('Race A');
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		expect(requests[1].init?.method).toBe('PATCH');
		requests[1].respond(Response.json({ id: 9102, location: 'Race A' }));
		await later;
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
		requests[2].respond(Response.json({ id: 9102, location: 'Race A' }));
		expect((await rename).cacheRefreshed).toBe(true);
	});

	it('does not apply an in-flight refresh over a newly queued optimistic write', async () => {
		const { requests, fetch } = controlledFetch();
		inventory.upsertSpool(mapSpool({ id: 9105, location: 'Race A' }));
		const rename = spoolSource.renameFieldValue('location', 'Race A', 'Race B');
		requests[0].respond(Response.json({ spools_updated: 1 }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		inventory.patchSpool(9105, { location: 'Race C' });
		const later = spoolSource.saveSpool(9105, { location: 'Race C' });
		requests[1].respond(Response.json({ id: 9105, location: 'Race B' }));
		expect(inventory.spoolById(9105)?.location).toBe('Race C');
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
		expect(requests[2].init?.method).toBe('PATCH');
		requests[2].respond(Response.json({ id: 9105, location: 'Race C' }));
		await later;
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
		requests[3].respond(Response.json({ id: 9105, location: 'Race C' }));
		expect((await rename).cacheRefreshed).toBe(true);
	});

	it('refreshes the renamed value when a later queued write fails', async () => {
		const { requests, fetch } = controlledFetch();
		inventory.upsertSpool(mapSpool({ id: 9109, location: 'Race A' }));
		const rename = spoolSource.renameFieldValue('location', 'Race A', 'Race B');
		inventory.patchSpool(9109, { location: 'Race C' });
		const later = spoolSource.saveSpool(9109, { location: 'Race C' });
		const rejected = expect(later).rejects.toMatchObject({ status: 503 });
		requests[0].respond(Response.json({ spools_updated: 1 }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		expect(requests[1].init?.method).toBe('PATCH');
		requests[1].respond(new Response('{}', { status: 503 }));
		await rejected;
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
		requests[2].respond(Response.json({ id: 9109, location: 'Race B' }));
		expect(await rename).toEqual({ updated: 1, cacheRefreshed: true });
		expect(inventory.spoolById(9109)?.location).toBe('Race B');
	});

	it('retries an older read after a later bulk rename completes', async () => {
		const { requests, fetch } = controlledFetch();
		inventory.upsertSpool(mapSpool({ id: 9111, location: 'Race A' }));
		const first = spoolSource.renameFieldValue('location', 'Race A', 'Race B');
		requests[0].respond(Response.json({ spools_updated: 1 }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		const second = spoolSource.renameFieldValue('location', 'Race B', 'Race C');
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
		expect(requests[2].url).toContain('/spool/field/location');
		requests[2].respond(Response.json({ spools_updated: 1 }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
		requests[3].respond(Response.json({ id: 9111, location: 'Race C' }));
		expect(await second).toEqual({ updated: 1, cacheRefreshed: true });
		requests[1].respond(Response.json({ id: 9111, location: 'Race B' }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
		requests[4].respond(Response.json({ id: 9111, location: 'Race C' }));
		expect(await first).toEqual({ updated: 1, cacheRefreshed: true });
		expect(inventory.spoolById(9111)?.location).toBe('Race C');
	});

	it('retains candidates for an overlapping rename when the earlier refresh fails', async () => {
		const { requests, fetch } = controlledFetch();
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			inventory.upsertSpool(mapSpool({ id: 9112, location: 'Race A' }));
			const first = spoolSource.renameFieldValue('location', 'Race A', 'Race B');
			requests[0].respond(Response.json({ spools_updated: 1 }));
			await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
			const second = spoolSource.renameFieldValue('location', 'Race B', 'Race C');
			await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
			requests[1].respond(new Response('{}', { status: 503 }));
			expect(await first).toEqual({ updated: 1, cacheRefreshed: false });
			expect(inventory.isSpoolUncertain(9112)).toBe(true);

			requests[2].respond(Response.json({ spools_updated: 1 }));
			await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
			expect(requests[3].url).toMatch(/\/spool\/9112$/);
			requests[3].respond(Response.json({ id: 9112, location: 'Race C' }));
			expect(await second).toEqual({ updated: 1, cacheRefreshed: true });
			expect(inventory.spoolById(9112)?.location).toBe('Race C');
			expect(inventory.isSpoolUncertain(9112)).toBe(false);
		} finally {
			log.mockRestore();
		}
	});

	it('preserves other cached fields while refreshing a changed extra field', async () => {
		const { requests, fetch } = controlledFetch();
		inventory.upsertSpool(mapSpool({ id: 9103, extra: { rack: '"Race X"', note: '"local"' } }));
		const rename = spoolSource.renameFieldValue('extra.rack', 'Race A', 'Race B');
		inventory.upsertSpool(mapSpool({ id: 9103, extra: { rack: '"Race A"', note: '"newer"' } }));
		requests[0].respond(Response.json({ spools_updated: 1 }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		requests[1].respond(Response.json({ id: 9103, extra: { rack: '"Race B"', note: '"stale"' } }));
		expect((await rename).cacheRefreshed).toBe(true);
		expect(inventory.spoolById(9103)?.extra).toEqual({ rack: '"Race B"', note: '"newer"' });
	});

	it('reports a reconciliation failure without reporting the rename as failed', async () => {
		const { requests, fetch } = controlledFetch();
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			inventory.upsertSpool(mapSpool({ id: 9104, location: 'Race X' }));
			const rename = spoolSource.renameFieldValue('location', 'Race A', 'Race B');
			inventory.upsertSpool(mapSpool({ id: 9104, location: 'Race A' }));
			requests[0].respond(Response.json({ spools_updated: 1 }));
			await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
			requests[1].respond(new Response('{}', { status: 503 }));
			expect(await rename).toEqual({ updated: 1, cacheRefreshed: false });
			expect(inventory.spoolById(9104)?.location).toBe('Race A');
			expect(inventory.isSpoolUncertain(9104)).toBe(true);
			inventory.upsertSpool(mapSpool({ id: 9104, location: 'Race A' }));
			expect(inventory.isSpoolUncertain(9104)).toBe(true);
			const retry = spoolSource.refreshUncertainSpools([9104]);
			await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
			requests[2].respond(Response.json({ id: 9104, location: 'Race B' }));
			expect(await retry).toBe(true);
			expect(inventory.spoolById(9104)?.location).toBe('Race B');
			expect(inventory.isSpoolUncertain(9104)).toBe(false);
			expect(log).toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});

	it('removes a concurrently deleted spool when its refresh returns 404', async () => {
		const { requests, fetch } = controlledFetch();
		inventory.upsertSpool(mapSpool({ id: 9106, location: 'Race A' }));
		const rename = spoolSource.renameFieldValue('location', 'Race A', 'Race B');
		requests[0].respond(Response.json({ spools_updated: 1 }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		requests[1].respond(new Response('{}', { status: 404 }));
		expect((await rename).cacheRefreshed).toBe(true);
		expect(inventory.spoolById(9106)).toBeUndefined();
	});

	it('bounds a stalled reconciliation and releases later writes', async () => {
		vi.useFakeTimers();
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const fetch = vi.fn((url: string, init?: RequestInit) => {
			if (url.endsWith('/field/location')) return Promise.resolve(Response.json({ spools_updated: 1 }));
			if (init?.method === 'PATCH') return Promise.resolve(Response.json({ id: 9108, location: 'Done' }));
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
			});
		});
		vi.stubGlobal('fetch', fetch);
		try {
			inventory.upsertSpool(mapSpool({ id: 9107, location: 'Race A' }));
			const rename = spoolSource.renameFieldValue('location', 'Race A', 'Race B');
			const later = spoolSource.saveSpool(9108, { location: 'Done' });
			await vi.advanceTimersByTimeAsync(0);
			expect(fetch).toHaveBeenCalledTimes(3);
			await later;
			await vi.advanceTimersByTimeAsync(10_000);
			expect(await rename).toEqual({ updated: 1, cacheRefreshed: false });
			expect(fetch).toHaveBeenCalledTimes(3);
		} finally {
			log.mockRestore();
			vi.useRealTimers();
		}
	});

	it('allows enough time for a large group at ordinary request latency', async () => {
		vi.useFakeTimers();
		const fetch = vi.fn((url: string, init?: RequestInit) => {
			if (init?.method === 'PATCH') return Promise.resolve(Response.json({ spools_updated: 200 }));
			const id = Number(url.split('/').at(-1));
			return new Promise<Response>((resolve) =>
				setTimeout(() => resolve(Response.json({ id, location: 'Race B' })), 250)
			);
		});
		vi.stubGlobal('fetch', fetch);
		try {
			for (let id = 10000; id < 10200; id++) inventory.upsertSpool(mapSpool({ id, location: 'Race A' }));
			const rename = spoolSource.renameFieldValue('location', 'Race A', 'Race B');
			await vi.advanceTimersByTimeAsync(12_500);
			expect(await rename).toEqual({ updated: 200, cacheRefreshed: true });
			expect(fetch).toHaveBeenCalledTimes(201);
			expect(inventory.uncertainSpoolIds()).toEqual([]);
			expect(inventory.spoolById(10199)?.location).toBe('Race B');
		} finally {
			vi.useRealTimers();
		}
	});

	it('bounds reconciliation while a later write remains pending', async () => {
		vi.useFakeTimers();
		const { requests, fetch } = controlledFetch();
		try {
			inventory.upsertSpool(mapSpool({ id: 9110, location: 'Race A' }));
			const rename = spoolSource.renameFieldValue('location', 'Race A', 'Race B');
			const later = spoolSource.saveSpool(9110, { comment: 'pending' });
			requests[0].respond(Response.json({ spools_updated: 1 }));
			await vi.advanceTimersByTimeAsync(0);
			expect(fetch).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(await rename).toEqual({ updated: 1, cacheRefreshed: false });
			requests[1].respond(Response.json({ id: 9110, location: 'Race B', comment: 'pending' }));
			await later;
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps a multi-spool creation together before a bulk rename', async () => {
		const { fetch, requests } = controlledFetch();
		const creating = spoolSource.createSpools({ filament_id: 1, location: 'Shelf' }, 2);
		const rename = spoolSource.renameFieldValue('location', 'Shelf', 'Office');
		requests[0].respond(Response.json({ id: 9018, location: 'Shelf' }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		expect(requests[1].url).toMatch(/\/spool$/);
		requests[1].respond(Response.json({ id: 9019, location: 'Shelf' }));
		expect(await creating).toHaveLength(2);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
		expect(requests[2].url).toContain('/spool/field/location');
		requests[2].respond(Response.json({ spools_updated: 2 }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
		requests[3].respond(Response.json({ id: 9018, location: 'Office' }));
		requests[4].respond(Response.json({ id: 9019, location: 'Office' }));
		await rename;
	});

	it('reports the confirmed creations when a later spool POST fails', async () => {
		const { requests, fetch } = controlledFetch();
		const creating = spoolSource.createSpools({ filament_id: 1 }, 3);
		const failure = creating.catch((error: unknown) => error);
		requests[0].respond(Response.json({ id: 9023 }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		requests[1].respond(new Response('{}', { status: 503 }));
		const error: unknown = await failure;
		expect(error).toBeInstanceOf(SpoolBatchError);
		expect(error).toMatchObject({ created: 1, cause: { status: 503 } });
		expect(inventory.spoolById(9023)).toBeDefined();
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
