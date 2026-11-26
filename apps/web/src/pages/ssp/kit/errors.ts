import { ApiError } from '../../../api/client';

/** The Alert text for a failed write. A 400 carries the api's own message. */
export function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'validation_failed':
        return error.message;
      case 'csrf_failed':
        return 'The security check failed. Reload the page and try again.';
      case 'network_error':
        return "Can't reach the API. Check your connection and try again.";
      case 'forbidden':
        return 'Only an admin can do this.';
      case 'not_found':
        return 'It was already removed. The list has been reloaded.';
    }
  }
  return fallback;
}

/** A 400's per-field messages, from its `details` issues `{ path: [key], message }`. The first wins. */
export function fieldErrors(error: unknown): Record<string, string> {
  const found: Record<string, string> = {};
  if (!(error instanceof ApiError) || error.code !== 'validation_failed') return found;
  if (!Array.isArray(error.details)) return found;
  for (const issue of error.details as unknown[]) {
    if (typeof issue !== 'object' || issue === null) continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    const key: unknown = Array.isArray(path) ? path[0] : undefined;
    if (typeof key !== 'string' || typeof message !== 'string') continue;
    found[key] ??= message;
  }
  return found;
}
