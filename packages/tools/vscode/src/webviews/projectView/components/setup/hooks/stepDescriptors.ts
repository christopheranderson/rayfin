/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Single source of truth for the setup pipeline's step ordering
 * and section grouping. All step constants, section maps, and derived
 * helpers are defined here — no other file should hard-code these values.
 */

// ── Section identifiers ─────────────────────────────────────────────────

export type SetupSectionId = 'prereqs' | 'install' | 'deploy';
export type SetupWorkflowSection = SetupSectionId | 'done';

// ── Required pipeline steps (sequential: 0 → STEP_DONE − 1) ────────────

export const STEP_NODE = 0;
export const STEP_MODULES = 1;
export const STEP_MS_AUTH = 2;
export const STEP_DEPLOY = 3;
export const STEP_DONE = 4;

// ── Optional steps (local backend — outside the main pipeline) ──────────

export const STEP_DOCKER = 100;
export const STEP_GHCR = 101;

// ── Section → step mapping ──────────────────────────────────────────────

export const SECTION_PREREQS: SetupSectionId = 'prereqs';
export const SECTION_INSTALL: SetupSectionId = 'install';
export const SECTION_DEPLOY: SetupSectionId = 'deploy';

export const SECTION_STEPS: Record<SetupSectionId, readonly number[]> = {
  prereqs: [STEP_NODE],
  install: [STEP_MODULES],
  deploy: [STEP_MS_AUTH, STEP_DEPLOY],
};

/**
 * Ordered list of sections. Used by `sectionForStep` and for cascading
 * resets — refreshing a section invalidates all downstream sections.
 */
export const SECTION_ORDER: readonly SetupSectionId[] = [
  SECTION_PREREQS,
  SECTION_INSTALL,
  SECTION_DEPLOY,
];

// ── Helpers ─────────────────────────────────────────────────────────────

/** Resolve which section a required pipeline step belongs to. */
export function sectionForStep(step: number): SetupWorkflowSection {
  if (step >= STEP_DONE) return 'done';
  for (const section of SECTION_ORDER) {
    const steps = SECTION_STEPS[section];
    if (step <= steps[steps.length - 1]) return section;
  }
  return 'done';
}

/** Get the status of a step given the current pipeline position. */
export function stepState(
  stepIndex: number,
  currentStep: number
): 'done' | 'active' | 'pending' {
  if (stepIndex < currentStep) return 'done';
  if (stepIndex === currentStep) return 'active';
  return 'pending';
}
