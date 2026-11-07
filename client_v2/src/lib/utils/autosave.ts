// Feedback for edits that persist without an explicit Save press.
//
// Inline inspector fields, the settings page and the locations board all write
// straight through to the API on change. `trackSave` wraps those calls so the
// user gets a confirmation toast when the write lands — and an error toast (with
// the HTTP status, when we have one) when it doesn't, instead of the change
// silently reverting on the next refresh.

import { HttpError, WriteQueueTimeoutError } from '$lib/api/http';
import { toasts } from '$lib/stores/toasts.svelte';
import * as m from '$lib/paraglide/messages';

export function reportSaveError(error: unknown, context = 'Save failed', message?: string): void {
	console.error(context, error);
	const detail =
		error instanceof WriteQueueTimeoutError
			? m['notifications.writePending']()
			: m['notifications.error']({ statusCode: error instanceof HttpError ? error.status : '?' });
	toasts.error(message ? `${message} ${detail}` : detail);
}

/**
 * Report the outcome of an auto-save. Always resolves so fire-and-forget callers
 * do not produce unhandled rejections; the result lets inputs retain failed drafts.
 *
 * @param context Short label for the console log when the save fails.
 */
export function trackSave(promise: Promise<unknown>, context = 'Save failed'): Promise<boolean> {
	return promise.then(
		() => {
			toasts.success(m['notifications.saveSuccessful']());
			return true;
		},
		(e: unknown) => {
			reportSaveError(e, context);
			return false;
		}
	);
}
