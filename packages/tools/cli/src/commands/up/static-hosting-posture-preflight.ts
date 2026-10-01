/**
 * Layer 1 resolution of the static-hosting access posture.
 *
 * The posture decides who may open a deployed app. Interactive runs collect
 * the answer here; non-interactive runs use the fail-closed protected default.
 * The workflow persists the resolved intent.
 */
import type { RayfinConfig } from '@microsoft/rayfin-tools-common/_internal/config';
import {
  RECOMMENDED_STATIC_HOSTING_POSTURE,
  describeInvalidPostureError,
  inspectStaticHostingPosture,
  type StaticHostingPosture,
} from '@microsoft/rayfin-tools-common/_internal/workflows/up';
import inquirer from 'inquirer';

/** Outcome of {@link resolveStaticHostingPosture}. */
export type StaticHostingPostureResolution =
  /** Nothing to collect: gate off, no static surface, or already authored. */
  | { status: 'ok'; posture?: StaticHostingPosture }
  /** The run cannot proceed; `message` is ready to render. */
  | { status: 'failed'; message: string };

/** Inputs for {@link resolveStaticHostingPosture}. */
export interface ResolveStaticHostingPostureOptions {
  config: RayfinConfig;
  /** Resolved `cli-up-anonstatic` gate. */
  enabled: boolean;
  /** Whether this run may prompt. */
  interactive: boolean;
  /** Seam for tests; defaults to an inquirer list. */
  promptForPosture?: () => Promise<StaticHostingPosture>;
}

/**
 * Collect the posture a deploy will use, or explain why it cannot.
 *
 * Returns `ok` with no posture when the project already authored one: the
 * workflow re-reads the config, so passing it back would only duplicate it.
 */
export async function resolveStaticHostingPosture(
  options: ResolveStaticHostingPostureOptions
): Promise<StaticHostingPostureResolution> {
  const {
    config,
    enabled,
    interactive,
    promptForPosture = promptForStaticHostingPosture,
  } = options;

  const posture = inspectStaticHostingPosture(config.services);
  if (posture.state === 'invalid') {
    return {
      status: 'failed',
      message: describeInvalidPostureError(posture.value),
    };
  }

  if (!enabled || posture.state !== 'missing') {
    return { status: 'ok' };
  }

  if (!interactive)
    return { status: 'ok', posture: RECOMMENDED_STATIC_HOSTING_POSTURE };

  return { status: 'ok', posture: await promptForPosture() };
}

/**
 * Ask which posture to record.
 *
 * `protected` is listed first so Enter accepts the fail-closed option.
 */
async function promptForStaticHostingPosture(): Promise<StaticHostingPosture> {
  const { posture } = await inquirer.prompt<{ posture: StaticHostingPosture }>([
    {
      type: 'list',
      name: 'posture',
      message:
        'Who should be able to open your deployed app?\n' +
        '  Either choice keeps Rayfin auth available inside the app.',
      choices: [
        {
          name:
            'Only users with permissions to view the Fabric item will be able ' +
            'to retrieve any static assets. Visitors must sign in (recommended)',
          value: RECOMMENDED_STATIC_HOSTING_POSTURE,
        },
        {
          name:
            'Anyone with the link can be served static assets anonymously, no ' +
            'sign-in necessary',
          value: 'public',
        },
      ],
    },
  ]);

  return posture;
}
