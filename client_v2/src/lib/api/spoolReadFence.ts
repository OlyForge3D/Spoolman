import type { GroupField } from './types';
import type { Spool } from '$lib/types';

let revision = 0;
const renamedFields = new Set<GroupField>();

export function spoolReadRevision(): number {
	return revision;
}

export function noteSpoolRename(field: GroupField): void {
	revision++;
	renamedFields.add(field);
}

export function spoolHasFieldValue(spool: Spool, field: GroupField, value: string): boolean {
	if (field === 'location') return spool.location === value;
	if (!field.startsWith('extra.')) return false;
	const key = field.slice('extra.'.length);
	const raw = spool.extra[key];
	if (raw === undefined) return false;
	try {
		return JSON.parse(raw) === value;
	} catch (error) {
		console.warn(`Invalid cached spool extra field ${key}`, error);
		return false;
	}
}

/** Websocket payloads carry no revision, so changed renamed fields need a fresh read. */
export function possiblyStaleEventFields(spool: Spool, current: Spool | undefined): GroupField[] {
	return [...renamedFields].filter((field) => {
		if (!current) return true;
		if (field === 'location') return spool.location !== current.location;
		const key = field.slice('extra.'.length);
		return spool.extra[key] !== current.extra[key];
	});
}

export function isCurrentSpoolRead(readRevision: number): boolean {
	return readRevision === revision;
}

/** Re-read a response that overlapped a completed bulk rename. */
export async function readSpoolSnapshot<T, R>(
	read: () => Promise<T>,
	use: (result: T, readRevision: number) => R,
	signal?: AbortSignal
): Promise<R> {
	for (let attempt = 0; attempt < 4; attempt++) {
		const readRevision = revision;
		const result = await read();
		if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
		if (isCurrentSpoolRead(readRevision)) return use(result, readRevision);
	}
	throw new Error('Spool data kept changing while it was being loaded');
}
