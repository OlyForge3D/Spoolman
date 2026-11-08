import { describe, expect, it, vi } from 'vitest';
import { makeDraftTracker } from './draftTracker';

function deferred() {
	let resolve!: (success: boolean) => void;
	const promise = new Promise<boolean>((done) => (resolve = done));
	return { promise, resolve };
}

describe('makeDraftTracker', () => {
	it('keeps the latest draft through blur and refocus until its save succeeds', async () => {
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
	});

	it('keeps failed drafts until a later save succeeds', async () => {
		const clear = vi.fn();
		const tracker = makeDraftTracker(clear);

		tracker.focus('value');
		tracker.change('value', Promise.resolve(false));
		tracker.blur('value');
		await Promise.resolve();
		expect(clear).not.toHaveBeenCalled();

		tracker.focus('value');
		tracker.change('value', Promise.resolve(true));
		tracker.blur('value');
		await Promise.resolve();
		expect(clear).toHaveBeenCalledExactlyOnceWith('value');
	});

	it('does not clear invalid drafts or drafts whose component was disposed', async () => {
		let valid = false;
		const clear = vi.fn();
		const tracker = makeDraftTracker(clear, () => valid);
		const save = deferred();
		tracker.focus('value');
		tracker.change('value', save.promise);
		tracker.blur('value');
		save.resolve(true);
		await save.promise;
		expect(clear).not.toHaveBeenCalled();

		tracker.dispose();
		valid = true;
		tracker.blur('value');
		expect(clear).not.toHaveBeenCalled();
	});
});
