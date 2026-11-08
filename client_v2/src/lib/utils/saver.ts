// A debounced, patch-merging saver for inline-editable inspectors. Rapid edits
// (across fields) coalesce into one PATCH; switching entity flushes the pending
// patch first so it lands on the right one.

import type { Extra, ExtraPatch } from '$lib/types';

/** A synchronous edit, or the eventual outcome of an autosave. */
export type SaveResult = void | Promise<boolean>;

export interface Saver<Id, Patch> {
	push(id: Id, patch: Patch): Promise<boolean>;
	flush(): void;
	/**
	 * Drop the pending patch without sending it. For when the entity being edited
	 * is about to be deleted: flushing would PATCH a row that is on its way out,
	 * and the unmount flush would then fail with a 404 the user can do nothing about.
	 */
	cancel(): void;
}

// Extra-field saver: optimistically applies each keystroke to the cache (so the
// input reflects immediately) and debounces a merged PATCH of the changed keys.
//
// The API merges extra per key, so sending only the changed keys is safe — and is what
// keeps two people editing different fields of the same entity from overwriting each
// other. An emptied input (`json === undefined`) travels as an explicit null: that is
// what clears a stored value, whereas a key merely left out means "leave it as it is".
//
// The entity id is captured when the edit is made, so a pending patch always lands on
// the entity that was being edited even if the inspector has since switched to another
// one (the inspector components are reused across selections, not remounted).
export function makeExtraSaver<Id>(
	getId: () => Id,
	apply: (id: Id, extra: Extra) => void,
	persist: (id: Id, patch: ExtraPatch) => SaveResult,
	getCurrent: () => Extra,
	delay = 500
): {
	change: (key: string, json: string | undefined) => Promise<boolean>;
	flush: () => void;
	cancel: () => void;
} {
	const saver = makeSaver<Id, ExtraPatch>(persist, delay);

	function change(key: string, json: string | undefined) {
		const id = getId();
		const extra = { ...getCurrent() };
		if (json === undefined) delete extra[key];
		else extra[key] = json;
		apply(id, extra);
		return saver.push(id, { [key]: json ?? null });
	}

	return { change, flush: saver.flush, cancel: saver.cancel };
}

export function makeSaver<Id, Patch extends object>(
	save: (id: Id, patch: Patch) => SaveResult,
	delay = 500
): Saver<Id, Patch> {
	let currentId: Id | null = null;
	let pending: Partial<Patch> = {};
	let timer: ReturnType<typeof setTimeout> | null = null;
	let waiters: ((success: boolean) => void)[] = [];
	let saving = false;
	const queued: { id: Id; patch: Patch; waiters: ((success: boolean) => void)[] }[] = [];

	function stop() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}

	function enqueuePending() {
		if (currentId === null || Object.keys(pending).length === 0) return;
		queued.push({ id: currentId, patch: pending as Patch, waiters });
		pending = {};
		waiters = [];
	}

	function drain() {
		if (saving) return;
		const batch = queued.shift();
		if (!batch) return;
		saving = true;
		const settle = (success: boolean) => {
			batch.waiters.forEach((resolve) => resolve(success));
			saving = false;
			drain();
		};
		try {
			const result = save(batch.id, batch.patch);
			if (result === undefined) settle(true);
			else
				void result.then(settle, (error: unknown) => {
					console.error('Unexpected autosave failure', error);
					settle(false);
				});
		} catch (error) {
			console.error('Unexpected autosave failure', error);
			settle(false);
		}
	}

	function flush() {
		stop();
		enqueuePending();
		drain();
	}

	/** See {@link Saver.cancel}. */
	function cancel() {
		stop();
		pending = {};
		for (const resolve of waiters) resolve(false);
		waiters = [];
		for (const batch of queued) batch.waiters.forEach((resolve) => resolve(false));
		queued.length = 0;
	}

	function push(id: Id, patch: Patch) {
		if (currentId !== null && currentId !== id) flush();
		currentId = id;
		pending = { ...pending, ...patch };
		const result = new Promise<boolean>((resolve) => waiters.push(resolve));
		if (timer) clearTimeout(timer);
		timer = setTimeout(flush, delay);
		return result;
	}

	return { push, flush, cancel };
}
