import { describe, expect, it, vi } from 'vitest';
import { makeExtraSaver, makeSaver } from './saver';
import type { Extra, ExtraPatch } from '$lib/types';

// The extra saver is what turns an inspector edit into a PATCH, so these cover the two
// things that are easy to get wrong: clearing a value (which needs an explicit null —
// an absent key means "leave it alone") and a pending patch landing on the entity it
// was made on after the inspector has switched to another one.
function harness(initial: Extra, id = 1) {
	let current: Extra = { ...initial };
	let currentId = id;
	const persisted: { id: number; patch: ExtraPatch }[] = [];
	const saver = makeExtraSaver<number>(
		() => currentId,
		(_id, extra) => {
			current = extra;
		},
		(id, patch) => {
			persisted.push({ id, patch });
		},
		() => current,
		10
	);
	return {
		saver,
		persisted,
		get current() {
			return current;
		},
		select(next: number, extra: Extra) {
			currentId = next;
			current = { ...extra };
		}
	};
}

describe('makeExtraSaver', () => {
	it('sends only the changed key, since the API merges per key', () => {
		const h = harness({ shelf: '"A"', dry: 'true' });
		h.saver.change('shelf', '"B"');
		h.saver.flush();
		expect(h.persisted).toEqual([{ id: 1, patch: { shelf: '"B"' } }]);
	});

	it('clears an emptied field with an explicit null', () => {
		const h = harness({ shelf: '"A"', dry: 'true' });
		h.saver.change('shelf', undefined);
		h.saver.flush();
		expect(h.persisted).toEqual([{ id: 1, patch: { shelf: null } }]);
		// …and the cache drops the key immediately, so the input renders as unset.
		expect(h.current).toEqual({ dry: 'true' });
	});

	it('coalesces edits to several fields into one patch', () => {
		const h = harness({ shelf: '"A"', dry: 'true' });
		h.saver.change('shelf', '"B"');
		h.saver.change('dry', undefined);
		h.saver.flush();
		expect(h.persisted).toEqual([{ id: 1, patch: { shelf: '"B"', dry: null } }]);
	});

	it('re-setting a cleared field drops the null again', () => {
		const h = harness({ shelf: '"A"' });
		h.saver.change('shelf', undefined);
		h.saver.change('shelf', '"C"');
		h.saver.flush();
		expect(h.persisted).toEqual([{ id: 1, patch: { shelf: '"C"' } }]);
	});

	it('lands a pending patch on the entity it was made on', async () => {
		vi.useFakeTimers();
		try {
			const h = harness({ shelf: '"A"' });
			h.saver.change('shelf', '"B"');
			// The inspector is reused for another spool before the debounce elapses.
			h.select(2, { shelf: '"Z"' });
			vi.advanceTimersByTime(20);
			expect(h.persisted).toEqual([{ id: 1, patch: { shelf: '"B"' } }]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('flushes the previous entity before starting on the next one', () => {
		const h = harness({ shelf: '"A"' });
		h.saver.change('shelf', '"B"');
		h.select(2, { shelf: '"Z"' });
		h.saver.change('shelf', undefined);
		h.saver.flush();
		expect(h.persisted).toEqual([
			{ id: 1, patch: { shelf: '"B"' } },
			{ id: 2, patch: { shelf: null } }
		]);
	});

	it('does nothing when there is nothing pending', () => {
		const h = harness({ shelf: '"A"' });
		h.saver.flush();
		expect(h.persisted).toEqual([]);
	});
});

// Deleting the entity being edited is the one case where a pending patch must NOT
// be sent: the row is on its way out, so the PATCH could only come back 404 and
// toast an error the user can do nothing about.
describe('cancel', () => {
	it('drops a pending extra-field patch, and the unmount flush finds nothing', () => {
		const h = harness({ shelf: '"A"' });
		h.saver.change('shelf', '"B"');
		h.saver.cancel(1);
		h.saver.flush();
		expect(h.persisted).toEqual([]);
	});

	it('stops the extra-field debounce that was already scheduled', () => {
		vi.useFakeTimers();
		try {
			const h = harness({ shelf: '"A"' });
			h.saver.change('shelf', '"B"');
			h.saver.cancel(1);
			vi.advanceTimersByTime(100);
			expect(h.persisted).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('drops a pending field patch and stops its debounce', () => {
		vi.useFakeTimers();
		try {
			const saved: { id: number; patch: { name?: string } }[] = [];
			const saver = makeSaver<number, { name: string }>((id, patch) => {
				saved.push({ id, patch });
			}, 10);
			saver.push(1, { name: 'renamed' });
			saver.cancel(1);
			vi.advanceTimersByTime(100);
			saver.flush();
			expect(saved).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('leaves the saver usable afterwards', () => {
		const saved: { id: number; patch: { name?: string } }[] = [];
		const saver = makeSaver<number, { name: string }>((id, patch) => {
			saved.push({ id, patch });
		}, 10);
		saver.push(1, { name: 'dropped' });
		saver.cancel(1);
		saver.push(2, { name: 'kept' });
		saver.flush();
		expect(saved).toEqual([{ id: 2, patch: { name: 'kept' } }]);
	});
});

describe('save results', () => {
	it('settles coalesced edits with the persistence result', async () => {
		let resolveSave!: (success: boolean) => void;
		const persist = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					resolveSave = resolve;
				})
		);
		const saver = makeSaver<number, { name?: string }>(persist, 10);
		const first = saver.push(1, { name: 'first' });
		const latest = saver.push(1, { name: 'latest' });
		saver.flush();

		expect(persist).toHaveBeenCalledExactlyOnceWith(1, { name: 'latest' });
		resolveSave(true);
		await expect(first).resolves.toBe(true);
		await expect(latest).resolves.toBe(true);
	});

	it('resolves false when persistence fails or the pending edit is cancelled', async () => {
		const error = new Error('save failed');
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const saver = makeSaver<number, { name?: string }>(() => Promise.reject(error), 10);
			const failed = saver.push(1, { name: 'failed' });
			saver.flush();
			await expect(failed).resolves.toBe(false);

			const cancelled = saver.push(1, { name: 'cancelled' });
			saver.cancel(1);
			await expect(cancelled).resolves.toBe(false);
		} finally {
			log.mockRestore();
		}
	});

	it('serializes overlapping saves so an older response cannot land after a newer one', async () => {
		const pendingSaves: ((success: boolean) => void)[] = [];
		const persisted: { id: number; patch: { name?: string } }[] = [];
		const saver = makeSaver<number, { name?: string }>((id, patch) => {
			persisted.push({ id, patch });
			return new Promise<boolean>((resolve) => pendingSaves.push(resolve));
		}, 10);

		const first = saver.push(1, { name: 'first' });
		saver.flush();
		const latest = saver.push(1, { name: 'latest' });
		saver.flush();
		expect(persisted).toEqual([{ id: 1, patch: { name: 'first' } }]);

		pendingSaves[0](true);
		await expect(first).resolves.toBe(true);
		expect(persisted).toEqual([
			{ id: 1, patch: { name: 'first' } },
			{ id: 1, patch: { name: 'latest' } }
		]);
		pendingSaves[1](true);
		await expect(latest).resolves.toBe(true);
	});

	it('keeps queued patches attached to their entity when selection changes during a save', async () => {
		const pendingSaves: ((success: boolean) => void)[] = [];
		const persisted: { id: number; patch: { name?: string } }[] = [];
		const saver = makeSaver<number, { name?: string }>((id, patch) => {
			persisted.push({ id, patch });
			return new Promise<boolean>((resolve) => pendingSaves.push(resolve));
		}, 10);

		const first = saver.push(1, { name: 'first' });
		saver.flush();
		const previousSelection = saver.push(1, { name: 'queued old' });
		const nextSelection = saver.push(2, { name: 'new entity' });
		saver.flush();
		expect(persisted).toEqual([{ id: 1, patch: { name: 'first' } }]);

		pendingSaves[0](true);
		await expect(first).resolves.toBe(true);
		expect(persisted).toEqual([
			{ id: 1, patch: { name: 'first' } },
			{ id: 1, patch: { name: 'queued old' } }
		]);
		pendingSaves[1](true);
		await expect(previousSelection).resolves.toBe(true);
		expect(persisted.at(-1)).toEqual({ id: 2, patch: { name: 'new entity' } });
		pendingSaves[2](true);
		await expect(nextSelection).resolves.toBe(true);
	});

	it('cancels only the deleted entity and preserves queued edits for other entities', async () => {
		const pendingSaves: ((success: boolean) => void)[] = [];
		const persisted: { id: number; patch: { name?: string } }[] = [];
		const saver = makeSaver<number, { name?: string }>((id, patch) => {
			persisted.push({ id, patch });
			return new Promise<boolean>((resolve) => pendingSaves.push(resolve));
		}, 10);

		const inFlight = saver.push(1, { name: 'first' });
		saver.flush();
		const previousEntity = saver.push(1, { name: 'queued old' });
		const deletedEntity = saver.push(2, { name: 'deleted' });
		saver.flush();
		saver.cancel(2);
		await expect(deletedEntity).resolves.toBe(false);

		pendingSaves[0](true);
		await expect(inFlight).resolves.toBe(true);
		expect(persisted).toEqual([
			{ id: 1, patch: { name: 'first' } },
			{ id: 1, patch: { name: 'queued old' } }
		]);
		pendingSaves[1](true);
		await expect(previousEntity).resolves.toBe(true);
	});

	it('coalesces queued patches for the same entity behind an in-flight save', async () => {
		const pendingSaves: ((success: boolean) => void)[] = [];
		const persisted: { id: number; patch: { name?: string; comment?: string } }[] = [];
		const saver = makeSaver<number, { name?: string; comment?: string }>((id, patch) => {
			persisted.push({ id, patch });
			return new Promise<boolean>((resolve) => pendingSaves.push(resolve));
		}, 10);

		const first = saver.push(1, { name: 'first' });
		saver.flush();
		const middle = saver.push(1, { name: 'obsolete' });
		saver.flush();
		const latest = saver.push(1, { name: 'latest', comment: 'updated' });
		saver.flush();
		expect(persisted).toEqual([{ id: 1, patch: { name: 'first' } }]);

		pendingSaves[0](true);
		await expect(first).resolves.toBe(true);
		expect(persisted).toEqual([
			{ id: 1, patch: { name: 'first' } },
			{ id: 1, patch: { name: 'latest', comment: 'updated' } }
		]);
		pendingSaves[1](true);
		await expect(middle).resolves.toBe(true);
		await expect(latest).resolves.toBe(true);
	});
});
