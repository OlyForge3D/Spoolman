/**
 * GTIN (Global Trade Item Number) normalization, mirroring `spoolman/gtin.py`.
 *
 * GTIN is the GS1 umbrella standard for retail barcodes: UPC-A is GTIN-12, EAN-13 is GTIN-13
 * and EAN-8 is GTIN-8. The lengths are zero-pad equivalent, so the server stores every barcode
 * padded to 14 digits and rejects anything that isn't a valid GTIN. Normalizing here as well
 * means a half-typed barcode is caught before it becomes a request the API is bound to refuse.
 */

/** The lengths GS1 defines, shortest first. */
const GTIN_LENGTHS = [8, 12, 13, 14];
const GTIN_STORED_LENGTH = 14;

/** The GS1 mod-10 check digit for everything but a GTIN's last digit. */
function checkDigit(digits: string): number {
	let total = 0;
	for (let i = 0; i < digits.length; i++) {
		// Weights 3 and 1 alternate from the right, so they line up the same way at every length.
		const weight = (digits.length - 1 - i) % 2 === 0 ? 3 : 1;
		total += Number(digits[i]) * weight;
	}
	return (10 - (total % 10)) % 10;
}

/**
 * A barcode as its zero-padded 14 digit GTIN, or null if it isn't a valid one.
 *
 * Non-digit characters are stripped first, so the separators printed under a barcode and any
 * whitespace a scanner appends are tolerated. A vendor article number such as `PF01001` and a
 * mis-scanned value such as `04850807Z` both come back null rather than being stored as a barcode.
 */
export function normalizeGtin(value: string | undefined | null): string | null {
	if (!value) return null;

	const digits = value.replace(/\D/g, '');
	if (!GTIN_LENGTHS.includes(digits.length)) return null;
	if (Number(digits[digits.length - 1]) !== checkDigit(digits.slice(0, -1))) return null;

	return digits.padStart(GTIN_STORED_LENGTH, '0');
}

/**
 * A stored GTIN in the shortest GS1 length that fits it — the form printed on the product.
 *
 * Undoes the padding for display, so a UPC-A stored as `00850078714923` reads as `850078714923`.
 */
export function formatGtin(value: string | undefined | null): string {
	if (!value) return '';

	const significant = value.replace(/^0+/, '');
	const length = GTIN_LENGTHS.find((l) => significant.length <= l);
	return length === undefined ? value : significant.padStart(length, '0');
}
