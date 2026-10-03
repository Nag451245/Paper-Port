import { describe, it, expect } from 'vitest';
import { cleanCredential, quotePlus } from '../../src/lib/credential-text.js';

describe('broker credential text', () => {
  it('strips the spaces, line breaks and invisible characters a copy-paste brings along', () => {
    expect(cleanCredential(' 5jf*K~9 ​\r\n')).toBe('5jf*K~9');
    expect(cleanCredential('﻿abc\tdef')).toBe('abcdef');
  });

  it('encodes like Python urllib.parse.quote_plus, as ICICI\'s login-link sample does', () => {
    // Expected value produced by Python 3.12: quote_plus("ab*12~x+y/z=q (1)!'")
    expect(quotePlus("ab*12~x+y/z=q (1)!'")).toBe('ab%2A12~x%2By%2Fz%3Dq+%281%29%21%27');
  });
});
