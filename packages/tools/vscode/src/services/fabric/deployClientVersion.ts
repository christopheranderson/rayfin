/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Version of the Rayfin deploy logic this extension embeds.
 *
 * The workload gates static-hosting runtime-settings writes on the
 * `@microsoft/rayfin-cli` entry of `packageVersions` — presence identifies a
 * client new enough to author an access posture, and the numeric floor raises
 * that bar over time. The extension is not the CLI, but it embeds the same
 * `@microsoft/rayfin-tools-common` deploy logic and speaks the same contract,
 * so it declares that package's version under the key the workload reads.
 *
 * Injected by esbuild (see `esbuild.mjs`) because tools-common is bundled and
 * has no `package.json` to read at runtime. The fallback only applies to a
 * bundle built without the define, which would fail the gate rather than
 * silently claim a version it does not have.
 */
declare const __RAYFIN_DEPLOY_CLIENT_VERSION__: string | undefined;

export const DEPLOY_CLIENT_VERSION: string =
  typeof __RAYFIN_DEPLOY_CLIENT_VERSION__ === 'string'
    ? __RAYFIN_DEPLOY_CLIENT_VERSION__
    : '0.0.0';
