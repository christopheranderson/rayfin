/**
 * GraphQL query builder supporting relationships nested to arbitrary depth.
 * Builds the selection set from a recursive tree — to-many relationships wrapped
 * in the DAB `{ items { } }` connection shape, to-one relationships nested
 * directly, scalars as leaves — and unwraps those `items` connections back into
 * plain arrays on read. Relationship cardinality is read from the entity's
 * decorator metadata; selecting a relationship therefore requires the connector
 * to register `entities` (otherwise the cardinality is unknown and the select
 * throws).
 */

import {
  getEntityMetadata,
  RelationshipTypes,
  type EntityClass,
  type EntityMetadata,
} from '@microsoft/rayfin-core';
import { GraphQLQueryBuilder } from '@microsoft/rayfin-data';
import type {
  EntitySchema,
  FieldSelection,
  FilterInput,
  OrderByInput,
  GraphQLClient,
} from '@microsoft/rayfin-data';

import { ConnectorsError } from '../Connectors';

import type { ConnectorFieldSelection } from './types';

/** A nested selection tree: field name → its child selections (empty ⇒ scalar leaf). */
type SelectionTree = Map<string, SelectionTree>;

export class ConnectorGraphQLQueryBuilder<
  TSchema extends EntitySchema,
  TEntity extends keyof TSchema,
> extends GraphQLQueryBuilder<TSchema, TEntity> {
  /**
   * Root entity metadata, present when the connector registered `entities`.
   * Drives relationship-aware selection shaping; absent for connectors without
   * registered entities, where selecting a relationship throws because its
   * cardinality is unknown.
   */
  private readonly rootMeta: EntityMetadata | undefined;

  constructor(
    graphqlClient: GraphQLClient,
    entityName: string,
    entityClass?: EntityClass
  ) {
    super(graphqlClient, entityName);
    this.rootMeta = entityClass ? getEntityMetadata(entityClass) : undefined;
  }

  /**
   * Constrain field selection to scalar columns and dotted relationship paths,
   * rejecting bare relationship names — enforced on chained calls too.
   */
  override select<const TFields extends readonly string[]>(
    fields: TFields & ConnectorFieldSelection<TSchema[TEntity], TFields>
  ): this {
    super.select(fields as unknown as FieldSelection<TSchema[TEntity]>);
    return this;
  }

  // Re-widen the base row-only chain back to the full connector builder so the
  // inherited `groupBy`/`aggregate` entry points stay reachable after a chained
  // read method. Each base method mutates and returns the same instance.

  override where(conditions: FilterInput<TSchema[TEntity]>): this {
    super.where(conditions);
    return this;
  }

  override orderBy(order: OrderByInput<TSchema[TEntity]>): this {
    super.orderBy(order);
    return this;
  }

  override first(count: number): this {
    super.first(count);
    return this;
  }

  override after(cursor: string): this {
    super.after(cursor);
    return this;
  }

  /** Build a nested selection tree from the flat, dotted selection paths. */
  private buildSelectionTree(paths: readonly string[]): SelectionTree {
    const root: SelectionTree = new Map();
    for (const path of paths) {
      let node = root;
      for (const segment of path.split('.')) {
        let child = node.get(segment);
        if (!child) {
          child = new Map();
          node.set(segment, child);
        }
        node = child;
      }
    }
    return root;
  }

  /**
   * Render a selection tree to a GraphQL selection set: to-many relationships
   * wrapped in the DAB `{ items { } }` shape, to-one relationships nested
   * directly, leaves bare. Cardinality comes from the entity's relationship
   * metadata (`meta`), which advances to the related entity as the walk
   * descends. A nested (relationship) selection therefore requires metadata:
   * if the connector registered no `entities`, selecting a relationship throws
   * rather than guessing its cardinality.
   */
  private renderSelectionTree(
    node: SelectionTree,
    indent: string,
    meta: EntityMetadata | undefined
  ): string {
    const inner = `${indent}  `;
    const parts: string[] = [];
    for (const [field, children] of node) {
      if (children.size === 0) {
        parts.push(`${inner}${field}`);
        continue;
      }
      if (!meta) {
        throw new ConnectorsError(
          `Cannot select relationship "${field}": register the connector's entities (config.entities) so relationship cardinality is known.`,
          'ENTITIES_REQUIRED_FOR_RELATIONSHIP_SELECT'
        );
      }
      const relationship = meta.fields[field]?.relationship;
      if (!relationship) {
        throw new ConnectorsError(
          `Cannot select "${field}" as a relationship on "${meta.name}": "${field}" is not a relationship field.`,
          'INVALID_RELATIONSHIP_SELECTION'
        );
      }
      const target = relationship.target();
      const childMeta = getEntityMetadata(target as EntityClass);
      if (relationship.type === RelationshipTypes.many) {
        const body = this.renderSelectionTree(
          children,
          `${inner}    `,
          childMeta
        );
        parts.push(
          `${inner}${field} {\n${inner}  items {\n${body}\n${inner}  }\n${inner}}`
        );
      } else {
        const body = this.renderSelectionTree(
          children,
          `${inner}  `,
          childMeta
        );
        parts.push(`${inner}${field} {\n${body}\n${inner}}`);
      }
    }
    return parts.join('\n');
  }

  protected override buildFieldSelection(): string {
    if (this.selections.length === 0) {
      throw new ConnectorsError(
        'A read requires an explicit .select([...]).',
        'SELECTION_REQUIRED'
      );
    }
    const tree = this.buildSelectionTree(
      this.selections.map((field) => String(field))
    );
    return this.renderSelectionTree(
      tree,
      '            ',
      this.rootMeta
    ).trimStart();
  }

  /**
   * Recursively unwrap DAB `items` connection objects so a nested plural
   * relationship surfaces as a plain array. A null in the chain stops
   * unwrapping there.
   */
  private unwrapNode(value: unknown, node: SelectionTree): void {
    if (value == null || typeof value !== 'object') {
      return;
    }
    const obj = value as Record<string, unknown>;
    for (const [field, children] of node) {
      if (children.size === 0) {
        continue;
      }
      let child = obj[field];
      if (
        child &&
        typeof child === 'object' &&
        !Array.isArray(child) &&
        Array.isArray((child as { items?: unknown }).items)
      ) {
        child = obj[field] = (child as { items: unknown[] }).items;
      }
      if (Array.isArray(child)) {
        for (const element of child) {
          this.unwrapNode(element, children);
        }
      } else if (child && typeof child === 'object') {
        this.unwrapNode(child, children);
      }
    }
  }

  protected override unwrapNestedConnectionItems(
    entities: TSchema[TEntity][]
  ): TSchema[TEntity][] {
    if (!entities.length || this.selections.length === 0) {
      return entities;
    }
    const tree = this.buildSelectionTree(
      this.selections.map((field) => String(field))
    );
    for (const entity of entities) {
      this.unwrapNode(entity, tree);
    }
    return entities;
  }
}
