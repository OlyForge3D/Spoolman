import {
	getFields,
	setField,
	deleteField,
	type EntityType,
	type FieldDef,
	type FieldParams
} from '$lib/api/fields';
import { SvelteSet } from 'svelte/reactivity';

// Reactive cache of extra-field definitions per entity type. Loaded on demand
// (inspectors) and by the settings manager; refetched after mutations.

const ENTITIES: EntityType[] = ['spool', 'filament', 'vendor'];
const LOAD_TIMEOUT_MS = 10_000;

function byOrder(list: FieldDef[]): FieldDef[] {
	return [...list].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

class Fields {
	private defs = $state<Record<EntityType, FieldDef[]>>({ spool: [], filament: [], vendor: [] });
	private readonly loading = new Map<EntityType, Promise<void>>();
	private readonly revisions: Record<EntityType, number> = { spool: 0, filament: 0, vendor: 0 };
	private readonly mutations = new Map<EntityType, Set<Promise<void>>>();
	private mutating = $state<Record<EntityType, number>>({ spool: 0, filament: 0, vendor: 0 });
	// Reactive so views can wait for the definitions rather than render against an
	// empty list and then rearrange themselves once they arrive.
	private loaded = $state<EntityType[]>([]);
	private failed = $state<EntityType[]>([]);

	get(entity: EntityType): FieldDef[] {
		return this.defs[entity] ?? [];
	}

	/** Whether this entity's definitions are in hand — an empty list is a real answer. */
	isLoaded(entity: EntityType): boolean {
		return this.loaded.includes(entity) && !this.failed.includes(entity) && this.mutating[entity] === 0;
	}

	failedEntities(): EntityType[] {
		return this.failed;
	}

	/** Load once (idempotent). */
	ensure(entity: EntityType) {
		if (!this.loaded.includes(entity)) void this.load(entity);
	}

	async loadRequired(entity: EntityType) {
		while (this.mutations.get(entity)?.size) await Promise.allSettled([...this.mutations.get(entity)!]);
		await this.loadNow(entity);
	}

	private async loadNow(entity: EntityType) {
		let pending = this.loading.get(entity);
		if (!pending) {
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout>;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					reject(new Error(`Loading ${entity} field definitions timed out`));
					controller.abort();
				}, LOAD_TIMEOUT_MS);
			});
			const load = (async () => {
				while (!controller.signal.aborted) {
					const revision = this.revisions[entity];
					const list = await getFields(entity, controller.signal);
					// Even a transport that ignores abort must not publish a late response.
					if (controller.signal.aborted) return;
					if (this.revisions[entity] !== revision) continue;
					this.revisions[entity]++;
					this.defs = { ...this.defs, [entity]: byOrder(list) };
					if (!this.loaded.includes(entity)) this.loaded = [...this.loaded, entity];
					return;
				}
			})();
			pending = Promise.race([load, timeout])
				.then(
					() => {
						this.failed = this.failed.filter((failed) => failed !== entity);
					},
					(error: unknown) => {
						if (!this.failed.includes(entity)) this.failed = [...this.failed, entity];
						throw error;
					}
				)
				.finally(() => clearTimeout(timer));
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

	private async finishMutation(entity: EntityType, revision: number, list: FieldDef[]) {
		const changed = this.revisions[entity] !== revision;
		this.revisions[entity]++;
		if (!changed) {
			this.defs = { ...this.defs, [entity]: byOrder(list) };
			return;
		}
		const pending = this.loading.get(entity);
		if (pending) {
			try {
				await pending;
			} catch (error) {
				console.warn('An overlapping %s field load failed before refresh', entity, error);
			} finally {
				if (this.loading.get(entity) === pending) this.loading.delete(entity);
			}
		}
		await this.loadNow(entity);
	}

	private mutate(entity: EntityType, action: () => Promise<FieldDef[]>): Promise<void> {
		const revision = this.revisions[entity];
		this.mutating = { ...this.mutating, [entity]: this.mutating[entity] + 1 };
		const operation = (async () => {
			let list: FieldDef[];
			try {
				list = await action();
			} catch (error) {
				this.loaded = this.loaded.filter((loaded) => loaded !== entity);
				if (!this.failed.includes(entity)) this.failed = [...this.failed, entity];
				throw error;
			}
			await this.finishMutation(entity, revision, list);
		})();
		const pending = operation.finally(() => {
			this.mutations.get(entity)?.delete(pending);
			this.mutating = { ...this.mutating, [entity]: this.mutating[entity] - 1 };
		});
		const mutations = this.mutations.get(entity) ?? new SvelteSet<Promise<void>>();
		mutations.add(pending);
		this.mutations.set(entity, mutations);
		return pending;
	}

	save(entity: EntityType, key: string, params: FieldParams) {
		return this.mutate(entity, () => setField(entity, key, params));
	}

	remove(entity: EntityType, key: string) {
		return this.mutate(entity, () => deleteField(entity, key));
	}
}

export const fields = new Fields();
