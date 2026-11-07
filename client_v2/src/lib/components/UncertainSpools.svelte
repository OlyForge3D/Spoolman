<script lang="ts">
	import { spoolSource } from '$lib/api/spoolSource';
	import { inventory } from '$lib/stores/inventory.svelte';
	import { toasts } from '$lib/stores/toasts.svelte';
	import { reportSaveError } from '$lib/utils/autosave';
	import * as m from '$lib/paraglide/messages';

	let { ids }: { ids: number[] } = $props();
	let retrying = $state(false);

	async function retry() {
		if (retrying) return;
		retrying = true;
		try {
			const refreshed = await spoolSource.refreshUncertainSpools(ids);
			if (!refreshed || ids.some((id) => inventory.isSpoolUncertain(id)))
				toasts.error(m['spool.uncertainRetryFailed']());
		} catch (error) {
			reportSaveError(error, 'Failed to refresh spool details', m['spool.uncertainRetryFailed']());
		} finally {
			retrying = false;
		}
	}
</script>

<div class="notice" role="alert">
	<p>{m['spool.uncertainDetails']()}</p>
	<button type="button" disabled={retrying} onclick={retry}>{m['buttons.retry']()}</button>
</div>

<style>
	.notice {
		display: grid;
		justify-items: center;
		gap: 10px;
		color: var(--text-dim);
		text-align: center;
		font-size: 13px;
	}
	.notice p {
		margin: 0;
	}
	.notice button {
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text);
		padding: 6px 12px;
		cursor: pointer;
	}
	.notice button:disabled {
		cursor: wait;
		opacity: 0.6;
	}
</style>
