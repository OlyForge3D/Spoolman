import type { SaveResult } from './saver';

interface DraftState {
	focused: boolean;
	pending: boolean;
	failed: boolean;
	sequence: number;
}

/**
 * Keep a draft until its latest save succeeds and the input is no longer focused.
 * A failed save stays editable; a later successful save releases the draft.
 */
export function makeDraftTracker(clear: (key: string) => void, canClear: () => boolean = () => true) {
	const states = new Map<string, DraftState>();
	let disposed = false;

	function stateFor(key: string): DraftState {
		let state = states.get(key);
		if (!state) {
			state = { focused: false, pending: false, failed: false, sequence: 0 };
			states.set(key, state);
		}
		return state;
	}

	function clearIfReady(key: string, state: DraftState) {
		if (!state.focused && !state.pending && !state.failed && canClear()) {
			clear(key);
			states.delete(key);
		}
	}

	function focus(key: string) {
		stateFor(key).focused = true;
	}

	function blur(key: string) {
		const state = stateFor(key);
		state.focused = false;
		clearIfReady(key, state);
	}

	function isProtected(key: string): boolean {
		const state = states.get(key);
		return !!state && (state.focused || state.pending || state.failed);
	}

	function change(key: string, result: SaveResult) {
		if (!result) return;
		const state = stateFor(key);
		const sequence = ++state.sequence;
		state.pending = true;
		state.failed = false;
		const finish = (success: boolean) => {
			if (disposed || sequence !== state.sequence) return;
			state.pending = false;
			state.failed = !success;
			clearIfReady(key, state);
		};
		void result.then(finish, (error: unknown) => {
			console.error('Unexpected autosave failure', error);
			finish(false);
		});
	}

	function dispose() {
		disposed = true;
		states.clear();
	}

	return { focus, blur, isProtected, change, dispose };
}
