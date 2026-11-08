import type { LabelBinding } from './template';

/** Stable across equivalent cache upserts, including reordered object keys. */
export function labelBindingSnapshot(binding: LabelBinding): string {
	// This display label ages even when the underlying last-used timestamp does not.
	const spool = binding.spool ? { ...binding.spool, lastUsedLabel: undefined } : undefined;
	return JSON.stringify({ ...binding, spool }, (_key, value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
	});
}
