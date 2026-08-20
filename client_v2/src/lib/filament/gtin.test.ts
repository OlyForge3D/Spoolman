import { describe, expect, it } from 'vitest';
import { formatGtin, normalizeGtin } from './gtin';

describe('normalizeGtin', () => {
	it('accepts every GS1 length and pads it to 14 digits', () => {
		expect(normalizeGtin('96385074')).toBe('00000096385074');
		expect(normalizeGtin('850078714923')).toBe('00850078714923');
		expect(normalizeGtin('6938936709947')).toBe('06938936709947');
		expect(normalizeGtin('00850078714923')).toBe('00850078714923');
	});

	it('stores the same barcode identically however many leading zeros it carries', () => {
		expect(normalizeGtin('850078714923')).toBe(normalizeGtin('0850078714923'));
		expect(normalizeGtin('0850078714923')).toBe(normalizeGtin('00850078714923'));
	});

	it('tolerates the separators printed under a barcode', () => {
		expect(normalizeGtin('0 850078 714923')).toBe('00850078714923');
		expect(normalizeGtin('  850078714923\n')).toBe('00850078714923');
	});

	it('rejects a bad check digit', () => {
		expect(normalizeGtin('850078714924')).toBeNull();
		expect(normalizeGtin('6938936709948')).toBeNull();
		// A mis-scanned label: the digits left over fail the GTIN-8 check digit.
		expect(normalizeGtin('04850807Z')).toBeNull();
	});

	it('rejects a vendor article number and anything of the wrong length', () => {
		expect(normalizeGtin('PF01001')).toBeNull();
		expect(normalizeGtin('ABS-CF-B')).toBeNull();
		expect(normalizeGtin('123456789')).toBeNull();
		expect(normalizeGtin('')).toBeNull();
		expect(normalizeGtin(undefined)).toBeNull();
		expect(normalizeGtin(null)).toBeNull();
	});
});

describe('formatGtin', () => {
	it('shows a stored GTIN in the length printed on the product', () => {
		expect(formatGtin('00850078714923')).toBe('850078714923');
		expect(formatGtin('06938936709947')).toBe('6938936709947');
		expect(formatGtin('00000096385074')).toBe('96385074');
		expect(formatGtin('10850078714920')).toBe('10850078714920');
	});

	it('has nothing to show for a filament with no barcode', () => {
		expect(formatGtin(undefined)).toBe('');
		expect(formatGtin('')).toBe('');
	});
});
