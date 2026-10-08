import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classifyExternalEmbed,
  getPinnedParentOrigin,
  isExternalEmbedScenario,
  resetExternalEmbedClassificationForTests,
} from '../externalEmbedClassification';
import {
  EXTERNAL_EMBED_ACK_KIND,
  EXTERNAL_EMBED_AUTH_CHANNEL,
  EXTERNAL_EMBED_READY_KIND,
  EXTERNAL_EMBED_SCENARIO,
} from '../externalEmbedProtocol';

const PARENT_ORIGIN = 'https://portal.contoso.com';

/**
 * Installs a distinct `window.parent` that captures posted messages. Returns
 * the captured-message list and a restore function.
 */
function installMockParent(): {
  posted: Array<{ data: any; targetOrigin: string }>;
  parent: { postMessage: (data: any, targetOrigin: string) => void };
  restore: () => void;
} {
  const posted: Array<{ data: any; targetOrigin: string }> = [];
  const parent = {
    postMessage: (data: any, targetOrigin: string) => {
      posted.push({ data, targetOrigin });
    },
  };
  const original = Object.getOwnPropertyDescriptor(window, 'parent');
  Object.defineProperty(window, 'parent', {
    value: parent,
    writable: true,
    configurable: true,
  });
  return {
    posted,
    parent,
    restore: () => {
      if (original) {
        Object.defineProperty(window, 'parent', original);
      }
    },
  };
}

/** Dispatches a message whose `source` is the mocked parent. */
function dispatchFromParent(
  parent: object,
  origin: string,
  data: unknown
): void {
  const event = new MessageEvent('message', { origin, data });
  Object.defineProperty(event, 'source', { value: parent, writable: false });
  window.dispatchEvent(event);
}

describe('externalEmbedClassification', () => {
  beforeEach(() => {
    resetExternalEmbedClassificationForTests();
  });

  afterEach(() => {
    resetExternalEmbedClassificationForTests();
    vi.restoreAllMocks();
  });

  it('classifies as externalEmbed when the parent acknowledges the scenario', async () => {
    const { posted, parent, restore } = installMockParent();
    try {
      const promise = classifyExternalEmbed(1000);

      // The readiness message is posted synchronously with a wildcard target.
      expect(posted).toHaveLength(1);
      expect(posted[0]?.targetOrigin).toBe('*');
      expect(posted[0]?.data).toMatchObject({
        channel: EXTERNAL_EMBED_AUTH_CHANNEL,
        kind: EXTERNAL_EMBED_READY_KIND,
      });

      dispatchFromParent(parent, PARENT_ORIGIN, {
        channel: EXTERNAL_EMBED_AUTH_CHANNEL,
        kind: EXTERNAL_EMBED_ACK_KIND,
        scenario: EXTERNAL_EMBED_SCENARIO,
      });

      await promise;

      expect(isExternalEmbedScenario()).toBe(true);
      expect(getPinnedParentOrigin()).toBe(PARENT_ORIGIN);
    } finally {
      restore();
    }
  });

  it('classifies as normal when the parent never acknowledges within the timeout', async () => {
    vi.useFakeTimers();
    const { restore } = installMockParent();
    try {
      const promise = classifyExternalEmbed(300);
      await vi.advanceTimersByTimeAsync(300);
      await promise;

      expect(isExternalEmbedScenario()).toBe(false);
      expect(getPinnedParentOrigin()).toBeUndefined();
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it('ignores acknowledgements from a source other than the parent', async () => {
    vi.useFakeTimers();
    const { parent, restore } = installMockParent();
    try {
      const promise = classifyExternalEmbed(300);

      // A message from an unrelated source must not classify.
      const impostor = { postMessage: () => {} };
      dispatchFromParent(impostor, 'https://evil.com', {
        channel: EXTERNAL_EMBED_AUTH_CHANNEL,
        kind: EXTERNAL_EMBED_ACK_KIND,
        scenario: EXTERNAL_EMBED_SCENARIO,
      });
      // A genuine ack from the parent still resolves it.
      dispatchFromParent(parent, PARENT_ORIGIN, {
        channel: EXTERNAL_EMBED_AUTH_CHANNEL,
        kind: EXTERNAL_EMBED_ACK_KIND,
        scenario: EXTERNAL_EMBED_SCENARIO,
      });

      await promise;
      expect(getPinnedParentOrigin()).toBe(PARENT_ORIGIN);
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it('is idempotent — a second call does not re-run the handshake', async () => {
    const { posted, parent, restore } = installMockParent();
    try {
      const promise = classifyExternalEmbed(1000);
      dispatchFromParent(parent, PARENT_ORIGIN, {
        channel: EXTERNAL_EMBED_AUTH_CHANNEL,
        kind: EXTERNAL_EMBED_ACK_KIND,
        scenario: EXTERNAL_EMBED_SCENARIO,
      });
      await promise;
      expect(posted).toHaveLength(1);

      await classifyExternalEmbed(1000);
      expect(posted).toHaveLength(1);
    } finally {
      restore();
    }
  });
});
