import type { FieldDef } from '$lib/api/fields';
import type { Extra } from '$lib/types';

export function withExtraDefaults(definitions: FieldDef[], current: Extra, cleared: string[] = []): Extra {
	const result = { ...current };
	for (const field of definitions) {
		if (field.default_value != null && !(field.key in result) && !cleared.includes(field.key))
			result[field.key] = field.default_value;
	}
	return result;
}

export function setExtraValue(
	current: Extra,
	key: string,
	value: string | undefined,
	cleared: string[]
): Extra {
	const result = { ...current };
	if (value === undefined) {
		delete result[key];
		if (!cleared.includes(key)) cleared.push(key);
	} else {
		result[key] = value;
		const index = cleared.indexOf(key);
		if (index !== -1) cleared.splice(index, 1);
	}
	return result;
}
