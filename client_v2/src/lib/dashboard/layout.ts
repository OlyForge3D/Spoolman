import { getSettings, setSetting, parseSetting } from '$lib/api/settings';

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
let pendingWrite: Promise<void> = Promise.resolve();
let writeRevision = 0;
const renameListeners = new Set<(field: string, oldKey: string, newKey: string) => void>();

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
	const s = await getSettings(signal);
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
		await pending;
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
		const writes: Promise<void>[] = [];
		if (renamed.groups !== current.groups) writes.push(setSetting('dashboard_groups', renamed.groups));
		if (renamed.spoolOrders !== current.spoolOrders)
			writes.push(setSetting('dashboard_spoolorders', renamed.spoolOrders));
		const results = await Promise.allSettled(writes);
		if (writes.length) writeRevision++;
		const failed = results.find((result) => result.status === 'rejected');
		if (failed?.status === 'rejected') throw failed.reason;
	});
	for (const listener of renameListeners) listener(field, oldKey, newKey);
}

export function saveGroups(field: string, order: string[]): void {
	const next = [...order];
	serialize(async () => {
		const current = await loadLayout();
		await setSetting('dashboard_groups', { ...current.groups, [field]: next });
		writeRevision++;
	}).catch((e) => console.error('Failed to save dashboard groups', e));
}

export function saveSpoolOrders(field: string, orders: Record<string, number[]>): void {
	const next = Object.fromEntries(Object.entries(orders).map(([key, ids]) => [key, [...ids]]));
	serialize(async () => {
		const current = await loadLayout();
		await setSetting('dashboard_spoolorders', { ...current.spoolOrders, [field]: next });
		writeRevision++;
	}).catch((e) => console.error('Failed to save dashboard spool order', e));
}
