export * from './schema-analyzer.js';
export * from './type-inference.js';
export * from './dialect-config.js';
export * from './dab-config-generator.js';
export * from './storage-config-generator.js';
export * from './validation-errors.js';
export * from './reserved-entity-names.js';

// Connector-path forks (named exports to avoid colliding with the shared
// data-path exports of the same names — `Config`, `Entity`, `Schema`, etc.).
export { ConnectorSchemaAnalyzer } from './connector-schema-analyzer.js';
export { ConnectorConfigGenerator } from './connector-dab-config-generator.js';
