/**
 * Error type and transport-error mapping for the app state client.
 */

import { BridgeError } from '@microsoft/fabric-embedded-host';
import { SdkError } from '@microsoft/rayfin-lib';

/**
 * Error thrown for invalid state or a host that cannot service the
 * request.
 *
 * The `code` is stable and safe to branch on; the `message` is not.
 * State values are never included in either, so the error can be logged
 * without leaking user data.
 *
 * Codes currently emitted:
 *
 * | Code | Meaning |
 * | --- | --- |
 * | `INVALID_STATE` | State is not JSON-serialisable |
 * | `STATE_TOO_LARGE` | State exceeds the encoded-size budget |
 * | `STATE_TOO_DEEP` | State exceeds the nesting-depth limit |
 * | `UNSUPPORTED_HOST_CAPABILITY` | Host does not implement deep-link state |
 * | `NO_HOST_WINDOW` | App is not running embedded in the Fabric portal |
 * | `BRIDGE_TIMEOUT` | Host did not respond in time |
 */
export class FabricAppStateError extends SdkError {
  public override name = 'FabricAppStateError';

  constructor(message: string, code: string) {
    super(message, code);
    Object.setPrototypeOf(this, FabricAppStateError.prototype);
  }
}

/**
 * Translate transport errors into a stable app-state vocabulary.
 *
 * A host that predates this feature, or has the feature switch off,
 * replies `UNKNOWN_CHANNEL`.  Surfacing that as
 * `UNSUPPORTED_HOST_CAPABILITY` lets an app degrade gracefully instead
 * of treating it as a bug.
 *
 * @internal
 */
export function toAppStateError(err: unknown): FabricAppStateError {
  if (err instanceof FabricAppStateError) return err;

  if (err instanceof BridgeError) {
    if (err.code === 'UNKNOWN_CHANNEL') {
      return new FabricAppStateError(
        'This Fabric host does not support deep-link state. The app should ' +
          'continue without it.',
        'UNSUPPORTED_HOST_CAPABILITY'
      );
    }
    return new FabricAppStateError(err.message, err.code ?? 'BRIDGE_ERROR');
  }

  return new FabricAppStateError(
    err instanceof Error ? err.message : 'Unknown app-state error.',
    'UNKNOWN_ERROR'
  );
}
