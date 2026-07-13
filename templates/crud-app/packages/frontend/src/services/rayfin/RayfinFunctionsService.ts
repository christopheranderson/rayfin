import type {
  HealthCheckResult,
  IFunctionsService,
} from '../interfaces/IFunctionsService';

import { getRayfinClient } from './RayfinClientService';

export class RayfinFunctionsService implements IFunctionsService {
  async healthCheck(): Promise<HealthCheckResult> {
    // Minimal functions-invocation demo. Locally this call is routed by the
    // Vite proxy to a running `func` host when one is up, otherwise to the
    // remote backend — the app code is identical either way.
    return getRayfinClient().functions.healthCheck.invoke({});
  }
}
