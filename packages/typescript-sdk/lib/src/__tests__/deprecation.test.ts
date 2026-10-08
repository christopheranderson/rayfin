import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  deprecate,
  deprecateFn,
  deprecateField,
  setDeprecationsSilenced,
  isDeprecationSilenced,
  __resetDeprecationsForTesting,
} from '../deprecation.js';

describe('deprecate', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetDeprecationsForTesting();
    delete process.env.RAYFIN_NO_DEPRECATION;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    __resetDeprecationsForTesting();
    delete process.env.RAYFIN_NO_DEPRECATION;
  });

  it('warns once per code by default', () => {
    deprecate('CODE_A', 'first');
    deprecate('CODE_A', 'first');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('dedupes by code, not by message', () => {
    deprecate('CODE_A', 'message one');
    deprecate('CODE_B', 'message two');
    deprecate('CODE_A', 'message one again');
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('formats with a [rayfin] prefix and appends the code', () => {
    deprecate('CODE_A', 'the thing is deprecated');
    expect(warnSpy.mock.calls[0][0]).toBe(
      '[rayfin] the thing is deprecated [CODE_A]'
    );
  });

  it('emits on every call when once is false', () => {
    deprecate('CODE_A', 'msg', { once: false });
    deprecate('CODE_A', 'msg', { once: false });
    deprecate('CODE_A', 'msg', { once: false });
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it('does not record the code when once is false', () => {
    deprecate('CODE_A', 'msg', { once: false });
    deprecate('CODE_A', 'msg');
    // The earlier once:false call must not have suppressed the once:true call.
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('is silenced by the programmatic toggle', () => {
    setDeprecationsSilenced(true);
    deprecate('CODE_A', 'msg');
    expect(warnSpy).not.toHaveBeenCalled();
    expect(isDeprecationSilenced()).toBe(true);
  });

  it('re-warns once after unsilencing', () => {
    setDeprecationsSilenced(true);
    deprecate('CODE_A', 'msg');
    setDeprecationsSilenced(false);
    deprecate('CODE_A', 'msg');
    deprecate('CODE_A', 'msg');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('is silenced by RAYFIN_NO_DEPRECATION=1', () => {
    process.env.RAYFIN_NO_DEPRECATION = '1';
    deprecate('CODE_A', 'msg');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('is silenced by RAYFIN_NO_DEPRECATION=true (case-insensitive)', () => {
    process.env.RAYFIN_NO_DEPRECATION = 'TRUE';
    deprecate('CODE_A', 'msg');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('is not silenced by other RAYFIN_NO_DEPRECATION values', () => {
    process.env.RAYFIN_NO_DEPRECATION = 'no';
    deprecate('CODE_A', 'msg');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('lets the programmatic override win over the env var', () => {
    process.env.RAYFIN_NO_DEPRECATION = '1';
    setDeprecationsSilenced(false);
    deprecate('CODE_A', 'msg');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('deprecateFn', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetDeprecationsForTesting();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    __resetDeprecationsForTesting();
  });

  it('warns when the wrapped function is called', () => {
    const wrapped = deprecateFn(() => 42, 'FN_CODE', 'old fn');
    expect(warnSpy).not.toHaveBeenCalled();
    wrapped();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('dedupes across calls by default', () => {
    const wrapped = deprecateFn(() => undefined, 'FN_CODE', 'old fn');
    wrapped();
    wrapped();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('warns on every call when once is false', () => {
    const wrapped = deprecateFn(() => undefined, 'FN_CODE', 'old fn', {
      once: false,
    });
    wrapped();
    wrapped();
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('preserves arguments and return value', () => {
    const wrapped = deprecateFn(
      (a: number, b: number) => a + b,
      'FN_CODE',
      'old fn'
    );
    expect(wrapped(2, 3)).toBe(5);
  });

  it('preserves the `this` binding', () => {
    const obj = {
      factor: 10,
      compute: deprecateFn(
        function (this: { factor: number }, n: number) {
          return this.factor * n;
        },
        'FN_CODE',
        'old method'
      ),
    };
    expect(obj.compute(4)).toBe(40);
  });
});

describe('deprecateField', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetDeprecationsForTesting();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    __resetDeprecationsForTesting();
  });

  it('warns when the trapped property is read', () => {
    const obj = { legacy: 'value' };
    deprecateField(obj, 'legacy', 'FIELD_CODE', 'old field');
    expect(warnSpy).not.toHaveBeenCalled();
    expect(obj.legacy).toBe('value');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('warns when the trapped property is written', () => {
    const obj = { legacy: 'value' };
    deprecateField(obj, 'legacy', 'FIELD_CODE', 'old field', { once: false });
    obj.legacy = 'next';
    expect(obj.legacy).toBe('next');
    // One warning for the set, one for the get.
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('dedupes get and set under a shared code by default', () => {
    const obj = { legacy: 'value' };
    deprecateField(obj, 'legacy', 'FIELD_CODE', 'old field');
    obj.legacy = 'next';
    void obj.legacy;
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
