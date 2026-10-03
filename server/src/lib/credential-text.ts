/**
 * Broker keys, secrets and session tokens never contain whitespace, but a
 * copy from a broker's web page often carries a trailing space, line break or
 * invisible zero-width character. Sent to ICICI, that makes a valid key fail
 * with "Public Key does not exist". Strip them on save and again on use, so
 * keys saved before this fix work without re-entering them.
 */
export const cleanCredential = (value: string): string => value.replace(/[\s​-‍⁠﻿]+/g, '');

/** Python's urllib.parse.quote_plus, which ICICI's own login-link sample uses. */
export const quotePlus = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, '+');
