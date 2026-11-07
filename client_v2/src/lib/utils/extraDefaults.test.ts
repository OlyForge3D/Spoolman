import { describe, expect, it } from 'vitest';
import { FieldType, type FieldDef } from '$lib/api/fields';
import { setExtraValue, withExtraDefaults } from './extraDefaults';

const definitions: FieldDef[] = [
	{
		key: 'one',
		name: 'One',
		order: 0,
		field_type: FieldType.text,
		entity_type: 'filament',
		default_value: '"one"'
	},
	{
		key: 'two',
		name: 'Two',
		order: 1,
		field_type: FieldType.text,
		entity_type: 'filament',
		default_value: '"two"'
	},
	{ key: 'three', name: 'Three', order: 2, field_type: FieldType.text, entity_type: 'filament' }
];

describe('extra-field defaults', () => {
	it('fills only missing values without replacing a copied or edited value', () => {
		expect(withExtraDefaults(definitions, { one: '"custom"' })).toEqual({ one: '"custom"', two: '"two"' });
	});

	it('keeps explicit clears across later definition loads and accepts a subsequent edit', () => {
		const cleared: string[] = [];
		const empty = setExtraValue({ one: '"one"' }, 'one', undefined, cleared);
		expect(withExtraDefaults(definitions, empty, cleared)).toEqual({ two: '"two"' });
		const edited = setExtraValue(empty, 'one', '"edited"', cleared);
		expect(withExtraDefaults(definitions, edited, cleared)).toEqual({ one: '"edited"', two: '"two"' });
	});
});
