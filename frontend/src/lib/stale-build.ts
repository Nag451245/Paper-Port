/**
 * After a deploy, a tab opened on the old version asks for page files that
 * the new build has replaced ("Failed to fetch dynamically imported module").
 * Reloading picks up the new version. Done at most once a minute, so a real
 * outage cannot cause a reload loop.
 */
const KEY = 'stale-build-reload-at';

export const isStaleBuildError = (err: unknown): boolean =>
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i
    .test(String((err as Error)?.message ?? err));

/** Reload once for a stale-build error; false if it already tried in the last minute. */
export function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch { /* storage blocked: still reload once */ }
  window.location.reload();
  return true;
}
