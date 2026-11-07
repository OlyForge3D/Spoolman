import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/toasts.svelte', () => ({
	toasts: { success: vi.fn(), error: vi.fn() }
}));
vi.mock('$lib/paraglide/messages', () => ({
	'notifications.saveSuccessful': () => 'saved',
	'notifications.error': ({ statusCode }: { statusCode: number | string }) => `error ${statusCode}`,
	'notifications.writePending': () => 'earlier write pending'
}));

import { HttpError, WriteQueueTimeoutError } from '$lib/api/http';
import { toasts } from '$lib/stores/toasts.svelte';
import { trackSave } from './autosave';

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe('trackSave', () => {
	it('reports a successful save', async () => {
		expect(await trackSave(Promise.resolve())).toBe(true);
		expect(toasts.success).toHaveBeenCalledWith('saved');
	});

	it('reports an HTTP failure with its status', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await trackSave(Promise.reject(new HttpError('failed', 503)))).toBe(false);
		expect(toasts.error).toHaveBeenCalledWith('error 503');
	});

	it('explains when a queued change was not sent', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await trackSave(Promise.reject(new WriteQueueTimeoutError()))).toBe(false);
		expect(toasts.error).toHaveBeenCalledWith('earlier write pending');
	});
});
