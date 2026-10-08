import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  startServer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../mcp.js', () => ({
  startServer: mocks.startServer,
}));

import { cli } from '../index';
import { startServer as mockedStart } from '../mcp.js';

describe('raymcp cli', () => {
  it('registers the start command and triggers the server', async () => {
    await cli.parseAsync(['start'], { from: 'user' });
    expect(mockedStart).toHaveBeenCalled();
  });

  it('exposes name, description, and version', () => {
    expect(cli.name()).toBe('raymcp');
    expect(cli.description()).toBe('Rayfin MCP tooling');
    expect(cli.version()).toMatch(/\d+\.\d+\.\d+/);
  });
});
