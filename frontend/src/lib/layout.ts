/**
 * When the app uses the sidebar layout rather than the phone layout (bottom
 * bar). Same rule as the `sidenav` variant in index.css: wide AND tall
 * enough, so a phone held sideways stays a phone.
 */
export const SIDEBAR_LAYOUT_QUERY = '(min-width: 48rem) and (min-height: 32rem)';

export function isPhoneLayout(): boolean {
  return typeof window !== 'undefined' && !window.matchMedia(SIDEBAR_LAYOUT_QUERY).matches;
}
