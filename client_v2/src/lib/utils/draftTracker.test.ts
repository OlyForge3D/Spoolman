import { describe, expect, it, vi } from 'vitest';
import { makeDraftTracker } from './draftTracker';

function deferred() {
	let resolve!: (success: boolean) => void;
	const promise = new Promise<boolean>((done) => (resolve = done));
	return { promise, resolve };
}

describe('makeDraftTracker', () => {
	it('keeps a draft through blur and refocus until its latest save succeeds', async () => {
		const clear = vi.fn();
		const tracker = makeDraftTracker(clear);
		const first = deferred();
		const latest = deferred();

		tracker.focus('value');
		tracker.change('value', first.promise);
		tracker.blur('value');
		tracker.focus('value');
		tracker.change('value', latest.promise);
		first.resolve(true);
		await first.promise;
		expect(clear).not.toHaveBeenCalled();

		tracker.blur('value');
		expect(clear).not.toHaveBeenCalled();
		latest.resolve(true);
		await latest.promise;
		expect(clear).toHaveBeenCalledExactlyOnceWith('value');
		expect(tracker.isProtected('value')).toBe(false);
	});

	it('does not release a focused draft or let an older result affect a newer one', async () => {
		const clear = vi.fn();
		const tracker = makeDraftTracker(clear);
		const older = deferred();
		const newer = deferred();

		tracker.focus('value');
		tracker.change('value', older.promise);
		tracker.change('value', newer.promise);
		newer.resolve(true);
		await newer.promise;
		expect(clear).not.toHaveBeenCalled();
		older.resolve(false);
		await older.promise;
		tracker.blur('value');
		expect(clear).toHaveBeenCalledExactlyOnceWith('value');
	});

	it('retains failed drafts until a later save succeeds', async () => {
		const clear = vi.fn();
		const tracker = makeDraftTracker(clear);
		tracker.focus('value');
		tracker.change('value', Promise.resolve(false));
		tracker.blur('value');
		await Promise.resolve();
		expect(clear).not.toHaveBeenCalled();
		expect(tracker.isProtected('value')).toBe(true);

		tracker.focus('value');
		tracker.change('value', Promise.resolve(true));
		tracker.blur('value');
		await Promise.resolve();
		expect(clear).toHaveBeenCalledExactlyOnceWith('value');
		expect(tracker.isProtected('value')).toBe(false);
	});

	it('preserves invalid drafts and supports synchronous form callbacks', () => {
		let valid = false;
		const clear = vi.fn();
		const tracker = makeDraftTracker(clear, () => valid);
		tracker.focus('value');
		tracker.change('value', undefined);
		tracker.blur('value');
		expect(clear).not.toHaveBeenCalled();
		valid = true;
		tracker.focus('value');
		tracker.blur('value');
		expect(clear).toHaveBeenCalledExactlyOnceWith('value');
	});

	it('ignores a save that completes after its component is disposed', async () => {
		const clear = vi.fn();
		const tracker = makeDraftTracker(clear);
		const save = deferred();
		tracker.change('value', save.promise);
		tracker.dispose();
		save.resolve(true);
		await save.promise;
		expect(clear).not.toHaveBeenCalled();
	});
});
