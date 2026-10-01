import { CONNECTOR_CATALOG } from '@microsoft/rayfin-tools-common/_internal/config';
import type { ConnectorType } from '@microsoft/rayfin-tools-common/_internal/config';

/**
 * The authoring view of the connector catalog: the types a Builder may reach
 * through `connector add`, `connector types` and `connector search`.
 *
 * The catalog itself stays complete so validation, generation, apply and
 * `rayfin up` keep working. Commands taking a `--type` from the user resolve
 * through here; those looking a connector up by *name* do not.
 */
export function listAuthorableConnectorTypes(): ConnectorType[] {
  return (Object.keys(CONNECTOR_CATALOG) as ConnectorType[]).filter(
    (type) => CONNECTOR_CATALOG[type].authoring === 'released'
  );
}

/**
 * Message for a `--type` the catalog knows but this release holds back, so the
 * Builder is not left thinking they typed the name wrong.
 *
 * Names what *is* available, matching the unknown-type message beside it —
 * otherwise a real-but-held name gets less help than a typo.
 */
export function heldConnectorTypeMessage(type: string): string {
  const supported = listAuthorableConnectorTypes().join(', ');
  return (
    `Connector type "${type}" is not available in this release. ` +
    `Supported types: [${supported}].`
  );
}

/**
 * True when the catalog carries `type` as its own key.
 *
 * `type in CONNECTOR_CATALOG` would also match `Object.prototype` members, so
 * `--type constructor` would be treated as a real-but-held type.
 */
export function isKnownConnectorType(type: string): boolean {
  return Object.hasOwn(CONNECTOR_CATALOG, type);
}
