import { InvocationContext } from '@microsoft/rayfin-tools-common/_internal/telemetry';
import { afterEach, describe, expect, it } from 'vitest';

import { setCurrentContext } from '../context-store.js';
import {
  addTelemetryEnvironment,
  recordFabricResponseActivity,
  resolveTelemetryEnvironment,
} from '../enrichment.js';

const TEST_ENV = {
  osType: 'linux',
  osVersion: 'test',
  nodeVersion: 'test',
};

describe('telemetry enrichment', () => {
  afterEach(() => {
    setCurrentContext(undefined);
  });

  it.each([
    [{ RAYFIN_TELEMETRY_ENV: 'local' }, 'local'],
    [{ RAYFIN_TELEMETRY_ENV: ' Customer_Prod-01 ' }, 'customer_prod-01'],
    [{ RAYFIN_TELEMETRY_ENV: 'customer.prod' }, 'other'],
    [{ RAYFIN_TELEMETRY_ENV: 'customer prod' }, 'other'],
    [{ RAYFIN_TELEMETRY_ENV: 'x'.repeat(65) }, 'other'],
    [{ RAYFIN_TELEMETRY_ENV: '  ', GITHUB_ACTIONS: 'true' }, 'github-actions'],
    [{ CODESPACES: 'true' }, 'codespaces'],
    [{ GITHUB_ACTIONS: 'true', CI: 'true' }, 'github-actions'],
    [{ TF_BUILD: 'True', CI: 'true' }, 'azure-pipelines'],
    [{ GITLAB_CI: 'true', CI: 'true' }, 'gitlab-ci'],
    [{ JENKINS_URL: 'https://jenkins.example' }, 'jenkins'],
    [{ REMOTE_CONTAINERS: 'true' }, 'devcontainer'],
    [{ CI: 'true' }, 'other'],
    [{}, undefined],
  ] as const)('resolves environment category %#', (variables, expected) => {
    expect(resolveTelemetryEnvironment(variables)).toBe(expected);
  });

  it('adds a normalized safe custom environment label to an invocation', () => {
    const context = new InvocationContext('rayfin-cli', '1.0.0');

    addTelemetryEnvironment(context, {
      RAYFIN_TELEMETRY_ENV: 'contoso-prod-eu',
    });

    expect(context.finalize(TEST_ENV).properties?.telemetry_environment).toBe(
      'contoso-prod-eu'
    );
  });

  it('records root activity IDs and RequestId fallbacks', () => {
    const context = new InvocationContext('rayfin-cli', '1.0.0');
    setCurrentContext(context);

    recordFabricResponseActivity(
      new Response(null, {
        headers: { 'x-ms-root-activity-id': 'root-activity-1' },
      })
    );
    recordFabricResponseActivity(
      new Response(null, { headers: { RequestId: 'request-2' } })
    );

    expect(context.finalize(TEST_ENV).properties?.fabric_activity_ids).toBe(
      '["root-activity-1","request-2"]'
    );
  });
});
