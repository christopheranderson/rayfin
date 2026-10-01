import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import * as remoteEndpointUtils from '../../utils/remote-endpoint-utils.js';
import { createCliDataService } from '../data.js';

// Exercise the REAL applyDbConfig (unlike data.test.ts, which mocks it) so the
// remote-without-endpoint preflight is covered end-to-end through the service.
vi.mock('../../utils/remote-endpoint-utils.js');

describe('createCliDataService — remote endpoint preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Silence the util's modeError/modeLog output.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a remote apply when no endpoint is configured instead of applying to local', async () => {
    vi.mocked(remoteEndpointUtils.hasRemoteEndpoint).mockReturnValue(false);

    await expect(
      createCliDataService().applyDatabaseConfig({
        projectRoot: '/proj',
        target: 'remote',
      })
    ).rejects.toThrow('No remote endpoint configured');
  });
});
