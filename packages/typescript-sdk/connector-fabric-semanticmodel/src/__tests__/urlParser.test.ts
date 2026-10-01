/**
 * Tests for Fabric / Power BI portal URL parsing.
 */

import { describe, it, expect } from 'vitest';

import { parseFabricUrl, parseSemanticModelUrl } from '../urlParser';

describe('parseFabricUrl', () => {
  it.each([
    [
      'https://app.fabric.microsoft.com/groups/ws-1/semanticmodels/item-1',
      { workspaceId: 'ws-1', itemId: 'item-1', itemType: 'semanticModel' },
    ],
    [
      'https://app.powerbi.com/groups/ws-1/datasets/item-1',
      { workspaceId: 'ws-1', itemId: 'item-1', itemType: 'semanticModel' },
    ],
    [
      'https://daily.powerbi.com/groups/me/modeling/item-1/calculations',
      { workspaceId: 'me', itemId: 'item-1', itemType: 'semanticModel' },
    ],
    [
      'https://app.fabric.microsoft.com/groups/ws-1/lakehouses/item-1',
      { workspaceId: 'ws-1', itemId: 'item-1', itemType: 'lakehouse' },
    ],
    [
      'https://app.fabric.microsoft.com/groups/ws-1/warehouses/item-1',
      { workspaceId: 'ws-1', itemId: 'item-1', itemType: 'warehouse' },
    ],
    [
      'https://msit.powerbi.com/onelake/details/ws-1/dataset/item-1/overview',
      { workspaceId: 'ws-1', itemId: 'item-1', itemType: 'semanticModel' },
    ],
    [
      'https://app.powerbi.com/onelake/details/ws-1/lakehouse/item-1',
      { workspaceId: 'ws-1', itemId: 'item-1', itemType: 'lakehouse' },
    ],
  ])('parses %s', (url, expected) => {
    expect(parseFabricUrl(url)).toEqual(expected);
  });

  it('ignores query strings and fragments', () => {
    expect(
      parseFabricUrl(
        'https://app.fabric.microsoft.com/groups/ws-1/semanticmodels/item-1?experience=power-bi#tab'
      )
    ).toEqual({
      workspaceId: 'ws-1',
      itemId: 'item-1',
      itemType: 'semanticModel',
    });
  });

  it('is case-insensitive on the type segment', () => {
    expect(
      parseFabricUrl(
        'https://app.fabric.microsoft.com/groups/ws-1/SemanticModels/item-1'
      ).itemType
    ).toBe('semanticModel');
  });

  it('tolerates a URL pasted with trailing quoting', () => {
    expect(
      parseFabricUrl(
        'https://app.fabric.microsoft.com/groups/ws-1/semanticmodels/item-1%22'
      ).itemId
    ).toBe('item-1');
  });

  it('prefers the OneLake shape when both anchors appear', () => {
    expect(
      parseFabricUrl(
        'https://app.powerbi.com/groups/ws-outer/reports/r-1/onelake/details/ws-inner/dataset/item-1'
      )
    ).toEqual({
      workspaceId: 'ws-inner',
      itemId: 'item-1',
      itemType: 'semanticModel',
    });
  });

  it.each([
    ['not a url at all', 'Invalid URL'],
    ['https://app.fabric.microsoft.com/', 'Could not extract'],
    ['https://app.fabric.microsoft.com/groups/ws-1', 'Could not extract'],
    [
      'https://app.fabric.microsoft.com/groups/ws-1/reports/item-1',
      'Could not extract',
    ],
  ])('rejects %s', (url, expectedMessage) => {
    expect(() => parseFabricUrl(url)).toThrow(expectedMessage);
  });
});

describe('parseSemanticModelUrl', () => {
  it('returns just the target for a semantic model URL', () => {
    expect(
      parseSemanticModelUrl(
        'https://app.fabric.microsoft.com/groups/ws-1/semanticmodels/item-1'
      )
    ).toEqual({ workspaceId: 'ws-1', itemId: 'item-1' });
  });

  it('rejects a URL for another item type at the point of configuration', () => {
    expect(() =>
      parseSemanticModelUrl(
        'https://app.fabric.microsoft.com/groups/ws-1/lakehouses/item-1'
      )
    ).toThrow('addresses a lakehouse, not a semantic model');
  });
});
