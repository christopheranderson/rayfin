import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FabricAuthBroker,
  FabricAuthLoginError,
  resolveTokenUrl,
} from '../dist/authBroker.js';

/** A controllable clock. */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function token(overrides = {}) {
  return {
    accessToken: 'access-1',
    tokenType: 'Bearer',
    expiresIn: 900,
    refreshToken: 'refresh-1',
    ...overrides,
  };
}

const REFRESH = {
  apiUrl: 'https://backend.example/appbackends/abc/',
  publishableKey: 'pk-test',
};

test('resolveTokenUrl preserves a backend path prefix', () => {
  assert.equal(
    resolveTokenUrl('https://backend.example/appbackends/abc/'),
    'https://backend.example/appbackends/abc/api/auth/v1/token'
  );
  assert.equal(
    resolveTokenUrl('https://backend.example/appbackends/abc'),
    'https://backend.example/appbackends/abc/api/auth/v1/token'
  );
  assert.equal(
    resolveTokenUrl('http://localhost:5168'),
    'http://localhost:5168/api/auth/v1/token'
  );
});

test('getValidToken returns null with no session', async () => {
  const broker = new FabricAuthBroker({ now: () => 0 });
  assert.equal(await broker.getValidToken(), null);
  assert.equal(broker.hasSession(), false);
});

test('completeLogin caches; token is fresh until skew window', async () => {
  const c = clock();
  const broker = new FabricAuthBroker({ now: c.now, refreshSkewMs: 60_000 });
  const resolved = broker.completeLogin('s1', token(), REFRESH);
  // No waiter registered, so it only cached.
  assert.equal(resolved, false);
  assert.equal(broker.hasSession(), true);

  // Fresh well before expiry.
  assert.deepEqual((await broker.getValidToken())?.accessToken, 'access-1');

  // Still fresh at expiry - skew - 1ms (900s - 60s = 840s window).
  c.advance(839_000);
  assert.equal((await broker.getValidToken())?.accessToken, 'access-1');
});

test('expired token without refresh token is evicted', async () => {
  const c = clock();
  const broker = new FabricAuthBroker({ now: c.now, refreshSkewMs: 0 });
  broker.completeLogin('s1', token({ refreshToken: null }), REFRESH);
  c.advance(901_000); // past 900s expiry
  assert.equal(await broker.getValidToken(), null);
  assert.equal(broker.hasSession(), false);
});

test('expired token is silently refreshed via the token endpoint', async () => {
  const c = clock();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        accessToken: 'access-2',
        tokenType: 'Bearer',
        expiresIn: 900,
        refreshToken: 'refresh-2',
      }),
    };
  };
  const broker = new FabricAuthBroker({
    now: c.now,
    refreshSkewMs: 0,
    fetchImpl,
  });
  broker.completeLogin('s1', token(), REFRESH);
  c.advance(901_000);

  const refreshed = await broker.getValidToken();
  assert.equal(refreshed?.accessToken, 'access-2');
  assert.equal(refreshed?.refreshToken, 'refresh-2');

  // Correct endpoint, method, headers, and body.
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://backend.example/appbackends/abc/api/auth/v1/token'
  );
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-Publishable-Key'], 'pk-test');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    grantType: 'refresh_token',
    refreshToken: 'refresh-1',
  });

  // The refreshed token is now cached and fresh again (no second fetch).
  const again = await broker.getValidToken();
  assert.equal(again?.accessToken, 'access-2');
  assert.equal(calls.length, 1);
});

test('refresh falls back to the prior refresh token when none is returned', async () => {
  const c = clock();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      accessToken: 'access-2',
      tokenType: 'Bearer',
      expiresIn: 900,
    }),
  });
  const broker = new FabricAuthBroker({
    now: c.now,
    refreshSkewMs: 0,
    fetchImpl,
  });
  broker.completeLogin('s1', token(), REFRESH);
  c.advance(901_000);
  const refreshed = await broker.getValidToken();
  assert.equal(refreshed?.refreshToken, 'refresh-1');
});

test('failed refresh evicts the session', async () => {
  const c = clock();
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    json: async () => ({}),
  });
  const broker = new FabricAuthBroker({
    now: c.now,
    refreshSkewMs: 0,
    fetchImpl,
  });
  broker.completeLogin('s1', token(), REFRESH);
  c.advance(901_000);
  assert.equal(await broker.getValidToken(), null);
  assert.equal(broker.hasSession(), false);
});

test('beginLogin resolves when a matching deposit arrives', async () => {
  const broker = new FabricAuthBroker();
  const pending = broker.beginLogin('state-xyz');
  assert.equal(broker.hasPending('state-xyz'), true);

  const matched = broker.completeLogin(
    'state-xyz',
    token({ accessToken: 'deposited' }),
    REFRESH
  );
  assert.equal(matched, true);

  const result = await pending;
  assert.equal(result.accessToken, 'deposited');
  assert.equal(broker.hasPending('state-xyz'), false);
});

test('deposit for an unknown state caches only, no waiter resolved', () => {
  const broker = new FabricAuthBroker();
  const matched = broker.completeLogin('never-registered', token(), REFRESH);
  assert.equal(matched, false);
  assert.equal(broker.hasSession(), true);
});

test('beginLogin rejects on timeout', async () => {
  const broker = new FabricAuthBroker({ loginTimeoutMs: 20 });
  const pending = broker.beginLogin('slow');
  await assert.rejects(pending, (err) => {
    assert.ok(err instanceof FabricAuthLoginError);
    assert.equal(err.code, 'FABRIC_AUTH_TIMEOUT');
    return true;
  });
  assert.equal(broker.hasPending('slow'), false);
});

test('failLogin rejects the pending login', async () => {
  const broker = new FabricAuthBroker();
  const pending = broker.beginLogin('s');
  broker.failLogin('s', 'bridge said no', 'FABRIC_AUTH_FAILED');
  await assert.rejects(pending, (err) => {
    assert.equal(err.code, 'FABRIC_AUTH_FAILED');
    assert.equal(err.message, 'bridge said no');
    return true;
  });
});

test('a second beginLogin for the same state supersedes the first', async () => {
  const broker = new FabricAuthBroker();
  const first = broker.beginLogin('dup');
  const second = broker.beginLogin('dup');
  await assert.rejects(first, (err) => {
    assert.equal(err.code, 'FABRIC_AUTH_ABORTED');
    return true;
  });
  broker.completeLogin('dup', token({ accessToken: 'win' }), REFRESH);
  assert.equal((await second).accessToken, 'win');
});

test('logout evicts the cached session but leaves pending logins alone', async () => {
  const broker = new FabricAuthBroker({ now: () => 0 });
  broker.completeLogin('s1', token(), REFRESH);
  assert.equal(broker.hasSession(), true);
  const pending = broker.beginLogin('s2');
  broker.logout();
  assert.equal(broker.hasSession(), false);
  assert.equal(broker.hasPending('s2'), true);
  // Clean up the pending promise so the test runner doesn't hang on its timer.
  broker.completeLogin('s2', token(), REFRESH);
  await pending;
});
