import {
  createFabricStatusClient,
  type FabricStatusClient,
} from '@microsoft/rayfin-tools-common/_internal/external/fabric';

import { createCliHttp } from '../../adapters/http.js';
import { ensureAuthenticated, isAuthenticated } from '../../auth/index.js';
import { getFabricSettings } from '../../config/constants.js';
import { hasAmbientToken } from '../../utils/ambient-env.js';

/** Supply a read-only Fabric session without ever starting interactive login. @internal */
export async function tryCreateCliFabricStatusClient(): Promise<FabricStatusClient | null> {
  if (!hasAmbientToken() && !(await isAuthenticated())) return null;
  const token = await ensureAuthenticated(undefined, { silent: true });
  return createFabricStatusClient(
    createCliHttp({ getToken: async () => token }, []),
    getFabricSettings().fabricApiBaseUrl
  );
}
