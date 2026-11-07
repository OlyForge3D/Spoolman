import { getSettings, setSetting, parseSetting } from '$lib/api/settings';
import { reportSaveError } from '$lib/utils/autosave';
import * as m from '$lib/paraglide/messages';

// The dashboard's saved layout: which cards a field's board shows, in what order, and
// the order of the spools inside each card. Both are stored per grouped-by field, so
// switching the view mode brings back that view's own arrangement.
//
// A group key is the field's value; the empty string is the "unassigned" card.

export interface DashboardLayout {
	/** field key → ordered group keys. */
	groups: Record<string, string[]>;
	/** field key → group key → ordered spool ids. */
	spoolOrders: Record<string, Record<string, number[]>>;
}

/** The field key whose layout the pre-dashboard location board's settings describe. */
const SEEDED_FIELD = 'location';
const LOAD_TIMEOUT_MS = 10_000;
let pendingWrite: Promise<void> = Promise.resolve();
let writeRevision = 0;
const renameListeners = new Set<(field: string, oldKey: string, newKey: string) => void>();
const queuedGroups = new Set<{ field: string; order: string[] }>();
const queuedSpoolOrders = new Set<{ field: string; orders: Record<string, number[]> }>();

function serialize<T>(write: () => Promise<T>): Promise<T> {
	const result = pendingWrite.then(write);
	pendingWrite = result.then(
		() => undefined,
		() => undefined
	);
	return result;
}

export function observeLayoutRenames(listener: (field: string, oldKey: string, newKey: string) => void) {
	renameListeners.add(listener);
	return () => renameListeners.delete(listener);
}

export async function loadLayout(signal?: AbortSignal): Promise<DashboardLayout> {
	if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
	const controller = new AbortController();
	let onAbort: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error('Loading dashboard layout timed out'));
			controller.abort();
		}, LOAD_TIMEOUT_MS);
	});
	const cancelled = new Promise<never>((_, reject) => {
		onAbort = () => {
			reject(new DOMException('The operation was aborted', 'AbortError'));
			controller.abort();
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
	let s;
	try {
		s = await Promise.race([getSettings(controller.signal), timeout, cancelled]);
	} finally {
		clearTimeout(timer!);
		if (onAbort) signal?.removeEventListener('abort', onAbort);
	}
	const groups = parseSetting<Record<string, string[]>>(s.dashboard_groups, {});
	const spoolOrders = parseSetting<Record<string, Record<string, number[]>>>(s.dashboard_spoolorders, {});

	// Before the dashboard there was a location-only board, whose layout lived in
	// `locations` / `locations_spoolorders`. Those keys still belong to the old client, so
	// they are read as a one-time seed for the location view and never written back — an
	// upgrade keeps the shelves it had, and the old client keeps working unchanged.
	if (!groups[SEEDED_FIELD]) {
		const seed = parseSetting<string[]>(s.locations, []).filter((l) => l != null);
		if (seed.length) groups[SEEDED_FIELD] = seed;
	}
	if (!spoolOrders[SEEDED_FIELD]) {
		const seed = parseSetting<Record<string, number[]>>(s.locations_spoolorders, {});
		if (Object.keys(seed).length) spoolOrders[SEEDED_FIELD] = seed;
	}

	return { groups, spoolOrders };
}

/** Load after local writes, retrying if one completes while settings are in flight. */
export async function loadCurrentLayout(signal?: AbortSignal): Promise<DashboardLayout> {
	for (let attempt = 0; attempt < 4; attempt++) {
		const pending = pendingWrite;
		await new Promise<void>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new DOMException('The operation was aborted', 'AbortError'));
				return;
			}
			const finish = (error?: Error) => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', abort);
				if (error) reject(error);
				else resolve();
			};
			const abort = () => finish(new DOMException('The operation was aborted', 'AbortError'));
			const timer = setTimeout(
				() => finish(new Error('Waiting for dashboard layout writes timed out')),
				LOAD_TIMEOUT_MS
			);
			signal?.addEventListener('abort', abort, { once: true });
			void pending.then(() => finish());
		});
		const revision = writeRevision;
		const layout = await loadLayout(signal);
		if (pending === pendingWrite && revision === writeRevision) return layout;
	}
	throw new Error('Dashboard layout kept changing while it was being loaded');
}

/** Rename only entries that still exist, preserving any newer destination order. */
export function renameLayoutGroup(
	layout: DashboardLayout,
	field: string,
	oldKey: string,
	newKey: string
): DashboardLayout {
	let { groups, spoolOrders } = layout;
	const groupOrder = groups[field];
	if (groupOrder?.includes(oldKey)) {
		const renamed = groupOrder.includes(newKey)
			? groupOrder.filter((key) => key !== oldKey)
			: groupOrder.map((key) => (key === oldKey ? newKey : key));
		groups = { ...groups, [field]: renamed };
	}

	const orders = spoolOrders[field];
	if (orders && Object.hasOwn(orders, oldKey)) {
		const { [oldKey]: carried, ...rest } = orders;
		const destination = rest[newKey] ?? [];
		const merged = [...destination, ...carried.filter((id) => !destination.includes(id))];
		spoolOrders = { ...spoolOrders, [field]: { ...rest, [newKey]: merged } };
	}
	return { groups, spoolOrders };
}

/** Re-read persisted layout after navigation before applying a completed rename. */
export async function renameSavedGroup(field: string, oldKey: string, newKey: string): Promise<void> {
	await serialize(async () => {
		const current = await loadLayout();
		const renamed = renameLayoutGroup(current, field, oldKey, newKey);
		const writes: { kind: 'groups' | 'orders'; promise: Promise<void> }[] = [];
		if (renamed.groups !== current.groups)
			writes.push({ kind: 'groups', promise: setSetting('dashboard_groups', renamed.groups) });
		if (renamed.spoolOrders !== current.spoolOrders)
			writes.push({ kind: 'orders', promise: setSetting('dashboard_spoolorders', renamed.spoolOrders) });
		const results = await Promise.allSettled(writes.map((write) => write.promise));
		if (writes.length) writeRevision++;
		const savedGroups = !writes.some(
			(write, index) => write.kind === 'groups' && results[index].status === 'rejected'
		);
		const savedOrders = !writes.some(
			(write, index) => write.kind === 'orders' && results[index].status === 'rejected'
		);
		for (const queued of queuedGroups) {
			if (savedGroups && queued.field === field)
				queued.order = renameLayoutGroup(
					{ groups: { [field]: queued.order }, spoolOrders: {} },
					field,
					oldKey,
					newKey
				).groups[field];
		}
		for (const queued of queuedSpoolOrders) {
			if (savedOrders && queued.field === field)
				queued.orders = renameLayoutGroup(
					{ groups: {}, spoolOrders: { [field]: queued.orders } },
					field,
					oldKey,
					newKey
				).spoolOrders[field];
		}
		const failed = results.find((result) => result.status === 'rejected');
		if (failed?.status === 'rejected') throw failed.reason;
	});
	for (const listener of renameListeners) listener(field, oldKey, newKey);
}

export function saveGroups(field: string, order: string[]): void {
	const queued = { field, order: [...order] };
	queuedGroups.add(queued);
	serialize(async () => {
		try {
			const current = await loadLayout();
			await setSetting('dashboard_groups', { ...current.groups, [field]: queued.order });
			writeRevision++;
		} finally {
			queuedGroups.delete(queued);
		}
	}).catch((e) => reportSaveError(e, 'Failed to save dashboard groups', m['dashboard.layoutSaveFailed']()));
}

export function saveSpoolOrders(field: string, orders: Record<string, number[]>): void {
	const queued = {
		field,
		orders: Object.fromEntries(Object.entries(orders).map(([key, ids]) => [key, [...ids]]))
	};
	queuedSpoolOrders.add(queued);
	serialize(async () => {
		try {
			const current = await loadLayout();
			await setSetting('dashboard_spoolorders', { ...current.spoolOrders, [field]: queued.orders });
			writeRevision++;
		} finally {
			queuedSpoolOrders.delete(queued);
		}
	}).catch((e) =>
		reportSaveError(e, 'Failed to save dashboard spool order', m['dashboard.layoutSaveFailed']())
	);
}
