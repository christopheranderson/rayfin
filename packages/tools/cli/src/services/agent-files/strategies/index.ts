/**
 * Strategy registry — maps `ItemKind` to its handler.
 */

import type { ItemKind } from '../types.js';

import { mcpKeyStrategy } from './mcp-key.js';
import { skillStrategy } from './skill.js';
import type { Strategy } from './strategy.js';

export type { Strategy } from './strategy.js';

const REGISTRY: Record<ItemKind, Strategy> = {
  skill: skillStrategy,
  mcp: mcpKeyStrategy,
};

export function getStrategy(kind: ItemKind): Strategy {
  return REGISTRY[kind];
}
