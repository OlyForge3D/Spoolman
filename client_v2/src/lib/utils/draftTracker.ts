import type { SaveResult } from './saver';

interface DraftState {
	focused: boolean;
	pending: boolean;
	failed: boolean;
	sequence: number;
}

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
		if (!disposed && !state.focused && !state.pending && !state.failed && canClear()) {
			clear(key);
			states.delete(key);
		}
	}

	function focus(key: string) {
		if (disposed) return;
		stateFor(key).focused = true;
	}

	function blur(key: string) {
		if (disposed) return;
		const state = stateFor(key);
		state.focused = false;
		clearIfReady(key, state);
	}

	function change(key: string, result: SaveResult) {
		if (disposed || result === undefined) return;
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

	return { focus, blur, change, dispose };
}
