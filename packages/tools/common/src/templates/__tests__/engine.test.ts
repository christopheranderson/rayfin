import { describe, it, expect } from 'vitest';

import { renderFilename } from '../engine/file-processor';

describe('renderFilename', () => {
  it('replaces __paramName__ placeholders', () => {
    const result = renderFilename('__projectName__.config.ts', {
      projectName: 'my-app',
    });
    expect(result).toBe('my-app.config.ts');
  });

  it('leaves unmatched placeholders unchanged', () => {
    const result = renderFilename('__unknown__.ts', {});
    expect(result).toBe('__unknown__.ts');
  });

  it('replaces multiple placeholders', () => {
    const result = renderFilename('__prefix__-__suffix__.txt', {
      prefix: 'hello',
      suffix: 'world',
    });
    expect(result).toBe('hello-world.txt');
  });

  it('handles underscored param names', () => {
    const result = renderFilename('__my_param__.txt', { my_param: 'value' });
    expect(result).toBe('value.txt');
  });
});
