// Message protocol types and validation
export type {
  EnvelopeBase,
  MessageEnvelope,
  ResponseError,
  SuccessResponse,
  ErrorResponse,
  BridgeResponse,
  EventEnvelope,
  BridgeEvent,
} from './MessageProtocol';
export { isMessageEnvelope, isEventEnvelope } from './MessageProtocol';

// Embedded mode detection
export type { EmbeddedModeOptions } from './embeddedMode';
export {
  isEmbeddedMode,
  clearEmbeddedMode,
  persistEmbeddedModeFromUrl,
} from './embeddedMode';

// PostMessage bridge transport
export type {
  BridgeRequestOptions,
  BridgeEventSubscriptionOptions,
} from './postMessageBridge';
export {
  BridgeError,
  sendBridgeRequest,
  subscribeBridgeEvents,
} from './postMessageBridge';
