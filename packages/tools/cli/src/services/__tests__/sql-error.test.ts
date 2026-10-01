import { describe, it, expect } from 'vitest';

import { HttpError } from '../../utils/retry-utils';
import { classifySqlAccessError } from '../sql-error';

describe('classifySqlAccessError', () => {
  it('classifies SQL permission-denied error numbers', () => {
    const result = classifySqlAccessError(
      Object.assign(new Error('SELECT permission was denied on the object'), {
        number: 229,
      })
    );

    expect(result.category).toBe('permission');
    expect(result.message).toContain('SELECT permission was denied');
  });

  it('classifies a server principal that cannot access the database', () => {
    expect(
      classifySqlAccessError(
        Object.assign(new Error('cannot access the database'), { number: 916 })
      ).category
    ).toBe('permission');
  });

  it('classifies ambiguous TDS login rejections as login, not auth', () => {
    expect(
      classifySqlAccessError(
        Object.assign(
          new Error("Login failed for user '<token-identified principal>'."),
          { number: 18456 }
        )
      ).category
    ).toBe('login');

    expect(
      classifySqlAccessError(
        Object.assign(new Error('login error'), { code: 'ELOGIN' })
      ).category
    ).toBe('login');
  });

  it('appends TDS diagnostics to the message', () => {
    const result = classifySqlAccessError(
      Object.assign(new Error('permission denied'), {
        number: 229,
        state: 1,
        class: 14,
        serverName: 'host.fabric.microsoft.com',
      })
    );

    expect(result.message).toContain(
      'State: 1, Class: 14, Server: host.fabric.microsoft.com'
    );
  });

  it('maps control-plane 403/401 responses', () => {
    expect(
      classifySqlAccessError(new HttpError('forbidden', 403)).category
    ).toBe('permission');
    expect(
      classifySqlAccessError(new HttpError('unauthorized', 401)).category
    ).toBe('auth');
    expect(
      classifySqlAccessError(new HttpError('not found', 404)).category
    ).toBe('unknown');
  });

  it('falls back to unknown for uncategorized errors', () => {
    const result = classifySqlAccessError(new Error('Invalid object name'));

    expect(result.category).toBe('unknown');
    expect(result.message).toBe('Invalid object name');
  });
});
