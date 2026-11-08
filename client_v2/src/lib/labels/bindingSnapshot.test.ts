import { describe, expect, it, vi } from 'vitest';
import { mapFilament, mapSpool, mapVendor } from '$lib/api/map';
import { labelBindingSnapshot } from './bindingSnapshot';

describe('label binding snapshots', () => {
	it('ignores object identity and extra-field key order', () => {
		const first = {
			spool: mapSpool({ id: 1, extra: { a: '"a"', b: '"b"' } }),
			filament: mapFilament({ id: 2, name: 'PLA' }),
			vendor: mapVendor({ id: 3, name: 'Maker' })
		};
		const second = {
			vendor: mapVendor({ name: 'Maker', id: 3 }),
			filament: mapFilament({ name: 'PLA', id: 2 }),
			spool: mapSpool({ extra: { b: '"b"', a: '"a"' }, id: 1 })
		};
		expect(labelBindingSnapshot(first)).toBe(labelBindingSnapshot(second));
	});

	it('detects changes to the spool and its related filament and vendor', () => {
		const binding = {
			spool: mapSpool({ id: 1, comment: 'original' }),
			filament: mapFilament({ id: 2, name: 'PLA' }),
			vendor: mapVendor({ id: 3, name: 'Maker' })
		};
		const snapshot = labelBindingSnapshot(binding);
		expect(labelBindingSnapshot({ ...binding, spool: { ...binding.spool, comment: 'changed' } })).not.toBe(
			snapshot
		);
		expect(labelBindingSnapshot({ ...binding, filament: { ...binding.filament, name: 'PETG' } })).not.toBe(
			snapshot
		);
		expect(labelBindingSnapshot({ ...binding, vendor: { ...binding.vendor, name: 'Other' } })).not.toBe(
			snapshot
		);
	});

	it('ignores elapsed-time display changes while still comparing the actual last-used timestamp', () => {
		vi.useFakeTimers();
		try {
			const raw = { id: 1, last_used: '2026-01-01T12:00:00Z' };
			vi.setSystemTime(new Date('2026-01-01T12:01:00Z'));
			const before = mapSpool(raw);
			vi.setSystemTime(new Date('2026-01-01T12:02:00Z'));
			const after = mapSpool(raw);
			expect(after.lastUsedLabel).not.toBe(before.lastUsedLabel);
			expect(labelBindingSnapshot({ spool: after })).toBe(labelBindingSnapshot({ spool: before }));
			expect(labelBindingSnapshot({ spool: { ...after, lastUsed: '2026-01-01T12:01:00Z' } })).not.toBe(
				labelBindingSnapshot({ spool: before })
			);
		} finally {
			vi.useRealTimers();
		}
	});
});
