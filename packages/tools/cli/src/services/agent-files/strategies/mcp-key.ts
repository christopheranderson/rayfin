/**
 * `McpKeyStrategy` — Key-level ownership for `mcpServers.<name>` inside `.mcp.json`.
 *
 * Ownership rule: the strategy manages exactly the value at `mcpServers.<name>`.
 * Sibling keys (other MCP servers, user-added top-level fields like `inputs`) are
 * preserved on every update.
 *
 * Adoption: this strategy never claims an existing key as its own based on key
 * presence alone. Adoption is the manager's responsibility — it compares canonical
 * on-disk content to bundled content for an exact match.
 *
 * Hostile-shape handling: the strategy refuses to operate when the existing
 * `.mcp.json` has a non-object root or a non-object `mcpServers`. This prevents
 * silently clobbering user JSON.
 */

import { join } from 'node:path';

import { writeFileAtomic } from '../../../utils/atomic-write.js';
import { canonicalizeJson } from '../../../utils/canonical-json.js';
import type { Descriptor, ItemRef } from '../types.js';

import { readIfPresent, sha256Hex } from './strategy.js';
import type { Strategy } from './strategy.js';

const MCP_FILENAME = '.mcp.json';
const MCP_SERVERS_KEY = 'mcpServers';

class McpKeyStrategyImpl implements Strategy {
  read(projectRoot: string, item: ItemRef): string | null {
    const filePath = join(projectRoot, MCP_FILENAME);
    const raw = readIfPresent(filePath);
    if (raw === null) return null;

    const parsed = parseMcpJson(raw);
    const servers = getServersOrThrow(parsed);
    if (!(item.name in servers)) {
      return null;
    }
    return canonicalizeJson(servers[item.name]);
  }

  hash(canonicalContent: string): string {
    return sha256Hex(canonicalContent);
  }

  write(
    projectRoot: string,
    descriptor: Descriptor,
    bundledContent: string,
    force = false
  ): string {
    const filePath = join(projectRoot, MCP_FILENAME);
    const raw = readIfPresent(filePath);
    let parsed: Record<string, unknown>;
    if (raw === null) {
      parsed = {};
    } else {
      // When --force is set, fall back to {} on hostile shapes (malformed JSON,
      // non-object root) so the user's documented recovery path actually works.
      // Without --force we still throw so install --force is the only way to
      // overwrite a hand-edited file.
      try {
        parsed = parseMcpJson(raw);
      } catch (err) {
        if (!force) throw err;
        parsed = {};
      }
    }

    const value = parseBundledValue(bundledContent);

    let servers: Record<string, unknown>;
    const existingServers = parsed[MCP_SERVERS_KEY];
    if (existingServers === undefined) {
      servers = {};
    } else if (
      typeof existingServers === 'object' &&
      existingServers !== null &&
      !Array.isArray(existingServers)
    ) {
      servers = existingServers as Record<string, unknown>;
    } else if (force) {
      // mcpServers is the wrong shape — replace with our object so --force still
      // delivers on the spec promise. Other top-level user keys are preserved.
      servers = {};
    } else {
      throw new Error(
        `${MCP_FILENAME}: existing "${MCP_SERVERS_KEY}" must be an object; got ${describeShape(
          existingServers
        )}. Refusing to overwrite.`
      );
    }

    servers[descriptor.name] = value;
    parsed[MCP_SERVERS_KEY] = servers;

    const canonicalValue = canonicalizeJson(value);
    // Use canonicalizeJson for the whole file so repeated writes produce a
    // stable byte-for-byte output regardless of which CLI version wrote it
    // last. Atomic write avoids torn JSON on SIGINT/disk full.
    writeFileAtomic(filePath, canonicalizeJson(parsed) + '\n', 'utf8');
    return canonicalValue;
  }

  delete(projectRoot: string, item: ItemRef): void {
    const filePath = join(projectRoot, MCP_FILENAME);
    const raw = readIfPresent(filePath);
    if (raw === null) return;

    const parsed = parseMcpJson(raw);
    const servers = getServersOrThrow(parsed);
    if (!(item.name in servers)) return;
    delete servers[item.name];
    parsed[MCP_SERVERS_KEY] = servers;
    writeFileAtomic(filePath, canonicalizeJson(parsed) + '\n', 'utf8');
  }

  canonicalizeBundled(bundledContent: string): string {
    return canonicalizeJson(parseBundledValue(bundledContent));
  }

  hasManagedSigil(_canonicalContent: string): boolean {
    return false;
  }
}

// ── Internals ──────────────────────────────────────────────────────────────

function parseMcpJson(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${MCP_FILENAME} is not valid JSON: ${(err as Error).message}. ` +
        `Refusing to overwrite. Repair the file by hand and retry.`
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${MCP_FILENAME} root must be a JSON object; got ${describeShape(
        parsed
      )}. Refusing to overwrite.`
    );
  }
  return parsed as Record<string, unknown>;
}

function getServersOrThrow(
  parsed: Record<string, unknown>
): Record<string, unknown> {
  const servers = parsed[MCP_SERVERS_KEY];
  if (servers === undefined) {
    return {};
  }
  if (
    typeof servers !== 'object' ||
    servers === null ||
    Array.isArray(servers)
  ) {
    throw new Error(
      `${MCP_FILENAME}: "${MCP_SERVERS_KEY}" must be an object; got ${describeShape(
        servers
      )}. Refusing to operate.`
    );
  }
  return servers as Record<string, unknown>;
}

function parseBundledValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Internal error: bundled MCP server asset is not valid JSON: ${
        (err as Error).message
      }`
    );
  }
}

function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export const mcpKeyStrategy: Strategy = new McpKeyStrategyImpl();
