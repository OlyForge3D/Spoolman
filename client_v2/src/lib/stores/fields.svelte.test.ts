import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/config', () => ({ API_BASE: 'http://spoolman.test/api/v1' }));

import { fields } from './fields.svelte';
import { FieldType } from '$lib/api/fields';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('required field definitions', () => {
	it('shares an in-flight load, reports its failure, and permits a retry', async () => {
		const requests: ((response: Response) => void)[] = [];
		const fetch = vi.fn(() => new Promise<Response>((resolve) => requests.push(resolve)));
		vi.stubGlobal('fetch', fetch);
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const background = fields.load('spool');
		const required = fields.loadRequired('spool');
		const rejected = expect(required).rejects.toMatchObject({ status: 503 });
		expect(fetch).toHaveBeenCalledOnce();
		requests[0](new Response('{}', { status: 503 }));
		await Promise.all([background, rejected]);
		expect(fields.isLoaded('spool')).toBe(false);

		const retry = fields.loadRequired('spool');
		expect(fetch).toHaveBeenCalledTimes(2);
		requests[1](
			Response.json([
				{ key: 'later', entity_type: 'spool', name: 'Later', order: 2, field_type: 'text' },
				{ key: 'first', entity_type: 'spool', name: 'First', order: 1, field_type: 'text' }
			])
		);
		await retry;
		expect(fields.isLoaded('spool')).toBe(true);
		expect(fields.get('spool').map((field) => field.key)).toEqual(['first', 'later']);
	});

	it('does not replace a saved definition with an older in-flight load', async () => {
		const requests: { method: string; respond: (response: Response) => void }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(
				(_url: string, init?: RequestInit) =>
					new Promise<Response>((respond) => requests.push({ method: init?.method ?? 'GET', respond }))
			)
		);
		const load = fields.loadRequired('filament');
		const saved = fields.save('filament', 'new', { name: 'New', order: 0, field_type: FieldType.text });
		expect(requests.map((request) => request.method)).toEqual(['GET', 'POST']);
		requests[1].respond(
			Response.json([{ key: 'new', entity_type: 'filament', name: 'New', order: 0, field_type: 'text' }])
		);
		await saved;
		requests[0].respond(Response.json([]));
		await load;
		expect(fields.get('filament').map((field) => field.key)).toEqual(['new']);
	});

	it('does not restore a deleted definition from an older in-flight load', async () => {
		const requests: ((response: Response) => void)[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(() => new Promise<Response>((resolve) => requests.push(resolve)))
		);
		const load = fields.loadRequired('vendor');
		const removed = fields.remove('vendor', 'old');
		requests[1](Response.json([]));
		await removed;
		requests[0](
			Response.json([{ key: 'old', entity_type: 'vendor', name: 'Old', order: 0, field_type: 'text' }])
		);
		await load;
		expect(fields.get('vendor')).toEqual([]);
	});
});
