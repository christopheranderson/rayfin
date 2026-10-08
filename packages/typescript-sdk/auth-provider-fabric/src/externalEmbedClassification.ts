import { assertBrowser } from '@microsoft/rayfin-lib';

import {
  EXTERNAL_EMBED_ACK_KIND,
  EXTERNAL_EMBED_AUTH_CHANNEL,
  EXTERNAL_EMBED_READY_KIND,
  EXTERNAL_EMBED_SCENARIO,
} from './externalEmbedProtocol';

/**
 * externalEmbed scenario classification.
 *
 * In embedded mode a third-party parent page may broker external-Entra
 * authentication for this app. The app cannot tell such a host apart from the
 * normal Fabric extension host by inspection, so on load it announces readiness
 * once and treats a scenario acknowledgement as the classifier.
 *
 * The result is held in module state — like the Fabric user hint — so that
 * every entry point (`ensureSignedInWithFabric`, `initEmbeddedAuth`) triggers
 * the same one-shot classification and `embeddedFabricLogin` can read it to
 * decide sign-out and payload shape without re-running the handshake.
 *
 * @internal Not exported from the package barrel.
 */

/**
 * Short classification timeout (ms), deliberately distinct from the handoff
 * request timeout. A normal Fabric host never acknowledges, so this bound is
 * added to a normal embedded login in full; it is kept small so that path
 * incurs no material delay. An externalEmbed parent acknowledges synchronously,
 * well within the bound.
 */
export const EXTERNAL_EMBED_CLASSIFY_TIMEOUT_MS = 300;

interface PinnedParent {
  source: Window;
  origin: string;
}

// `undefined` = not classified yet; `null` = normal Fabric; object = externalEmbed (pinned parent).
let classification: PinnedParent | null | undefined;

/**
 * Runs the one-shot externalEmbed handshake if it has not run this page load.
 *
 * Posts a single readiness message to the parent and waits up to
 * {@link EXTERNAL_EMBED_CLASSIFY_TIMEOUT_MS} for an acknowledgement declaring
 * the externalEmbed scenario. Idempotent: subsequent calls are no-ops.
 */
export async function classifyExternalEmbed(
  timeoutMs = EXTERNAL_EMBED_CLASSIFY_TIMEOUT_MS
): Promise<void> {
  assertBrowser('classifyExternalEmbed');
  if (classification !== undefined) {
    return;
  }
  const parent = window.parent;
  if (!parent || parent === window) {
    classification = null;
    return;
  }

  classification = await new Promise<PinnedParent | null>((resolve) => {
    let settled = false;
    const requestId = crypto.randomUUID();

    function finish(result: PinnedParent | null): void {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(result);
    }

    function onMessage(event: MessageEvent): void {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (event.source !== parent) return;
      if (data.channel !== EXTERNAL_EMBED_AUTH_CHANNEL) return;
      if (data.kind !== EXTERNAL_EMBED_ACK_KIND) return;
      if (data.scenario !== EXTERNAL_EMBED_SCENARIO) return;
      // Pin the parent's origin from the acknowledgement for the later handoff.
      finish({ source: parent as Window, origin: event.origin });
    }

    window.addEventListener('message', onMessage);
    const timer = setTimeout(() => finish(null), timeoutMs);

    // The iframe cannot know the parent's origin a priori and the readiness
    // signal carries no secret, so it is posted with a wildcard target; the
    // acknowledgement pins the origin for everything that follows.
    (parent as Window).postMessage(
      {
        channel: EXTERNAL_EMBED_AUTH_CHANNEL,
        version: 1,
        kind: EXTERNAL_EMBED_READY_KIND,
        requestId,
      },
      '*'
    );
  });
}

/**
 * Whether the current load was classified as the externalEmbed scenario.
 * Returns `false` until {@link classifyExternalEmbed} has resolved.
 */
export function isExternalEmbedScenario(): boolean {
  return Boolean(classification);
}

/**
 * The parent origin pinned during the handshake, or `undefined` when not in the
 * externalEmbed scenario. Used as the `postMessage` target for the handoff so
 * the request goes only to the acknowledged parent.
 */
export function getPinnedParentOrigin(): string | undefined {
  return classification ? classification.origin : undefined;
}

/**
 * Resets classification state.
 *
 * @internal Test helper.
 */
export function resetExternalEmbedClassificationForTests(): void {
  classification = undefined;
}
