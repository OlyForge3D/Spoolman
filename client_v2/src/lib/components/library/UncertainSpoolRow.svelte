<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve --
	   The href helper already resolves against the deploy base path. */
	import { page } from '$app/state';
	import * as params from '$lib/library/params';
	import * as m from '$lib/paraglide/messages';

	let { id, indent = 14 }: { id: number; indent?: number } = $props();
	let selected = $derived(params.isSelected(page.url.searchParams, 'spool', String(id)));
</script>

<a
	class="row"
	class:selected
	style="padding-left:{indent}px"
	href={params.selectHref(page.url.searchParams, 'spool', String(id))}
	data-sveltekit-keepfocus
	data-sveltekit-noscroll
>
	<span class="id mono">#{id}</span>
	<span>{m['spool.uncertainShort']()}</span>
</a>

<style>
	.row {
		display: flex;
		align-items: center;
		gap: 9px;
		width: 100%;
		padding: 8px 14px;
		border-top: 1px solid var(--hairline);
		border-left: 2px solid transparent;
		color: var(--text-dim);
		text-decoration: none;
		font-size: 12.5px;
	}
	.row:hover {
		background: var(--surface-2);
	}
	.row.selected {
		background: var(--accent-wash);
		border-left-color: var(--accent);
	}
	.id {
		width: 36px;
		color: var(--text-muted);
		font-size: 11px;
		flex: none;
	}
</style>
