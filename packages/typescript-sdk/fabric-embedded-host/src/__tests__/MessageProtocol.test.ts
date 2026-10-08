import { describe, it, expect } from 'vitest';

import { isMessageEnvelope } from '../MessageProtocol';

describe('isMessageEnvelope', () => {
  it('returns true for a valid envelope', () => {
    expect(
      isMessageEnvelope({
        channel: 'fabric-auth',
        version: 1,
        kind: 'auth.requestHandoff',
        requestId: 'abc-123',
      })
    ).toBe(true);
  });

  it('returns false for null', () => {
    expect(isMessageEnvelope(null)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isMessageEnvelope('hello')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isMessageEnvelope(42)).toBe(false);
  });

  it('returns false when channel is missing', () => {
    expect(
      isMessageEnvelope({
        version: 1,
        kind: 'response',
        requestId: 'abc',
      })
    ).toBe(false);
  });

  it('returns false when version is not a number', () => {
    expect(
      isMessageEnvelope({
        channel: 'test',
        version: '1',
        kind: 'response',
        requestId: 'abc',
      })
    ).toBe(false);
  });

  it('returns false when kind is missing', () => {
    expect(
      isMessageEnvelope({
        channel: 'test',
        version: 1,
        requestId: 'abc',
      })
    ).toBe(false);
  });

  it('returns false when requestId is missing', () => {
    expect(
      isMessageEnvelope({
        channel: 'test',
        version: 1,
        kind: 'response',
      })
    ).toBe(false);
  });

  it('allows extra properties', () => {
    expect(
      isMessageEnvelope({
        channel: 'test',
        version: 1,
        kind: 'response',
        requestId: 'abc',
        payload: { foo: 'bar' },
      })
    ).toBe(true);
  });
});
