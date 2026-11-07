import {
	getFields,
	setField,
	deleteField,
	type EntityType,
	type FieldDef,
	type FieldParams
} from '$lib/api/fields';

// Reactive cache of extra-field definitions per entity type. Loaded on demand
// (inspectors) and by the settings manager; refetched after mutations.

const ENTITIES: EntityType[] = ['spool', 'filament', 'vendor'];

function byOrder(list: FieldDef[]): FieldDef[] {
	return [...list].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

class Fields {
	private defs = $state<Record<EntityType, FieldDef[]>>({ spool: [], filament: [], vendor: [] });
	private readonly loading = new Map<EntityType, Promise<void>>();
	private readonly revisions: Record<EntityType, number> = { spool: 0, filament: 0, vendor: 0 };
	// Reactive so views can wait for the definitions rather than render against an
	// empty list and then rearrange themselves once they arrive.
	private loaded = $state<EntityType[]>([]);

	get(entity: EntityType): FieldDef[] {
		return this.defs[entity] ?? [];
	}

	/** Whether this entity's definitions are in hand — an empty list is a real answer. */
	isLoaded(entity: EntityType): boolean {
		return this.loaded.includes(entity);
	}

	/** Load once (idempotent). */
	ensure(entity: EntityType) {
		if (!this.loaded.includes(entity)) void this.load(entity);
	}

	async loadRequired(entity: EntityType) {
		let pending = this.loading.get(entity);
		if (!pending) {
			const revision = this.revisions[entity];
			pending = getFields(entity).then((list) => {
				if (this.revisions[entity] === revision) this.defs = { ...this.defs, [entity]: byOrder(list) };
				if (!this.loaded.includes(entity)) this.loaded = [...this.loaded, entity];
			});
			this.loading.set(entity, pending);
		}
		try {
			await pending;
		} finally {
			if (this.loading.get(entity) === pending) this.loading.delete(entity);
		}
	}

	async load(entity: EntityType) {
		try {
			await this.loadRequired(entity);
		} catch (e) {
			console.error(`Failed to load ${entity} fields`, e);
		}
	}

	loadAll() {
		for (const e of ENTITIES) void this.load(e);
	}

	async save(entity: EntityType, key: string, params: FieldParams) {
		const list = await setField(entity, key, params);
		this.revisions[entity]++;
		this.defs = { ...this.defs, [entity]: byOrder(list) };
	}

	async remove(entity: EntityType, key: string) {
		const list = await deleteField(entity, key);
		this.revisions[entity]++;
		this.defs = { ...this.defs, [entity]: byOrder(list) };
	}
}

export const fields = new Fields();
