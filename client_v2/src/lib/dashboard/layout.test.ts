import { afterEach, describe, expect, it, vi } from 'vitest';
import * as settings from '$lib/api/settings';
import {
	loadCurrentLayout,
	observeLayoutRenames,
	renameLayoutGroup,
	renameSavedGroup,
	saveGroups,
	saveSpoolOrders
} from './layout';

describe('renameLayoutGroup', () => {
	it('updates only the renamed field and retains newer destination order', () => {
		const layout = {
			groups: { location: ['before', 'old', 'new', 'after'], 'extra.rack': ['keep'] },
			spoolOrders: {
				location: { old: [1, 2], new: [3, 2], after: [4] },
				'extra.rack': { keep: [5] }
			}
		};

		expect(renameLayoutGroup(layout, 'location', 'old', 'new')).toEqual({
			groups: { location: ['before', 'new', 'after'], 'extra.rack': ['keep'] },
			spoolOrders: {
				location: { new: [3, 2, 1], after: [4] },
				'extra.rack': { keep: [5] }
			}
		});
		expect(layout.spoolOrders.location.old).toEqual([1, 2]);
	});

	it('does not reintroduce a group removed while the rename was pending', () => {
		const layout = { groups: { location: ['keep'] }, spoolOrders: { location: { keep: [5] } } };
		const renamed = renameLayoutGroup(layout, 'location', 'old', 'new');
		expect(renamed.groups).toBe(layout.groups);
		expect(renamed.spoolOrders).toBe(layout.spoolOrders);
	});
});

describe('saved layout writes', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	function mockSettings() {
		const state: Record<string, unknown> = {
			dashboard_groups: { location: ['old'], material: ['PLA'] },
			dashboard_spoolorders: { location: { old: [1, 2] }, material: { PLA: [3] } }
		};
		const response = () =>
			Object.fromEntries(
				Object.entries(state).map(([key, value]) => [
					key,
					{ value: JSON.stringify(value), is_set: true, type: 'object' }
				])
			);
		vi.spyOn(settings, 'getSettings').mockImplementation(async () => response());
		vi.spyOn(settings, 'setSetting').mockImplementation(async (key, value) => {
			state[key] = value;
		});
		return { state, response };
	}

	it('serializes field-specific saves and a rename without overwriting other fields', async () => {
		const { state } = mockSettings();
		const listener = vi.fn();
		const unsubscribe = observeLayoutRenames(listener);
		try {
			saveGroups('material', ['PETG', 'PLA']);
			saveSpoolOrders('material', { PETG: [4], PLA: [3] });
			await renameSavedGroup('location', 'old', 'new');
			expect(state.dashboard_groups).toEqual({ location: ['new'], material: ['PETG', 'PLA'] });
			expect(state.dashboard_spoolorders).toEqual({
				location: { new: [1, 2] },
				material: { PETG: [4], PLA: [3] }
			});
			expect(listener).toHaveBeenCalledExactlyOnceWith('location', 'old', 'new');
		} finally {
			unsubscribe();
		}
	});

	it('retries an initial layout load overtaken by a completed rename', async () => {
		const { response } = mockSettings();
		const stale = response();
		let resolveFirst!: (value: settings.SettingsMap) => void;
		vi.mocked(settings.getSettings)
			.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
			.mockImplementation(async () => response());
		const loading = loadCurrentLayout();
		await vi.waitFor(() => expect(settings.getSettings).toHaveBeenCalledTimes(1));
		await renameSavedGroup('location', 'old', 'new');
		resolveFirst(stale);
		const loaded = await loading;
		expect(loaded.groups.location).toEqual(['new']);
		expect(loaded.spoolOrders.location).toEqual({ new: [1, 2] });
	});

	it('keeps later writes behind both rename writes when one fails early', async () => {
		const { state } = mockSettings();
		let release: () => void = () => {};
		const pending = new Promise<void>((resolve) => (release = resolve));
		vi.mocked(settings.setSetting).mockImplementation(async (key, value) => {
			if (key === 'dashboard_groups') throw new Error('groups failed');
			await pending;
			state[key] = value;
		});
		const rename = renameSavedGroup('location', 'old', 'new');
		const failure = expect(rename).rejects.toThrow('groups failed');
		saveSpoolOrders('material', { PLA: [9] });
		await vi.waitFor(() => expect(settings.setSetting).toHaveBeenCalledTimes(2));
		expect(settings.getSettings).toHaveBeenCalledTimes(1);
		release();
		await failure;
		await vi.waitFor(() =>
			expect(state.dashboard_spoolorders).toEqual({
				location: { new: [1, 2] },
				material: { PLA: [9] }
			})
		);
	});

	it('rebases queued group and spool-order snapshots over an earlier rename', async () => {
		const { state } = mockSettings();
		const rename = renameSavedGroup('location', 'old', 'new');
		saveGroups('location', ['old', 'added']);
		saveSpoolOrders('location', { old: [1, 2], new: [3], added: [4] });
		await rename;
		await vi.waitFor(() => {
			expect(state.dashboard_groups).toEqual({ location: ['new', 'added'], material: ['PLA'] });
			expect(state.dashboard_spoolorders).toEqual({
				location: { new: [3, 1, 2], added: [4] },
				material: { PLA: [3] }
			});
		});
	});

	it('times out a stalled settings read without blocking later saves', async () => {
		vi.useFakeTimers();
		const { state, response } = mockSettings();
		let signal: AbortSignal | undefined;
		vi.mocked(settings.getSettings)
			.mockImplementationOnce((s) => {
				signal = s;
				return new Promise(() => {});
			})
			.mockImplementation(async () => response());
		vi.spyOn(console, 'error').mockImplementation(() => {});
		saveGroups('location', ['first']);
		saveGroups('material', ['PETG']);
		await vi.advanceTimersByTimeAsync(10_001);
		expect(signal?.aborted).toBe(true);
		expect(state.dashboard_groups).toEqual({ location: ['old'], material: ['PETG'] });
		expect(settings.setSetting).toHaveBeenCalledTimes(1);
		expect(console.error).toHaveBeenCalledOnce();
	});

	it('aborts a layout reader waiting behind a write without releasing that write', async () => {
		const { state } = mockSettings();
		let release!: () => void;
		const pending = new Promise<void>((resolve) => (release = resolve));
		vi.mocked(settings.setSetting).mockImplementation(async (key, value) => {
			if (key === 'dashboard_groups') await pending;
			state[key] = value;
		});
		const rename = renameSavedGroup('location', 'old', 'new');
		await vi.waitFor(() => expect(settings.setSetting).toHaveBeenCalledTimes(2));
		const controller = new AbortController();
		const loading = loadCurrentLayout(controller.signal);
		controller.abort();
		await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
		saveGroups('material', ['PETG']);
		await Promise.resolve();
		expect(settings.setSetting).toHaveBeenCalledTimes(2);
		release();
		await rename;
		await vi.waitFor(() => expect(state.dashboard_groups).toEqual({ location: ['new'], material: ['PETG'] }));
	});

	it('times out a layout reader without releasing a stalled sent write', async () => {
		vi.useFakeTimers();
		const { state } = mockSettings();
		let release!: () => void;
		const pending = new Promise<void>((resolve) => (release = resolve));
		vi.mocked(settings.setSetting).mockImplementation(async (key, value) => {
			if (key === 'dashboard_groups') await pending;
			state[key] = value;
		});
		const rename = renameSavedGroup('location', 'old', 'new');
		await vi.advanceTimersByTimeAsync(0);
		expect(settings.setSetting).toHaveBeenCalledTimes(2);
		const loading = loadCurrentLayout();
		const failure = expect(loading).rejects.toThrow('Waiting for dashboard layout writes timed out');
		await vi.advanceTimersByTimeAsync(10_001);
		await failure;
		saveGroups('material', ['PETG']);
		await vi.advanceTimersByTimeAsync(0);
		expect(settings.setSetting).toHaveBeenCalledTimes(2);
		release();
		await rename;
		await vi.advanceTimersByTimeAsync(0);
		expect(state.dashboard_groups).toEqual({ location: ['new'], material: ['PETG'] });
	});
});
