/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';

import {
  STEP_DEPLOY,
  STEP_DOCKER,
  STEP_DONE,
  STEP_GHCR,
  STEP_MODULES,
  STEP_MS_AUTH,
  STEP_NODE,
  stepState,
} from '../webviews/projectView/components/setup/hooks/stepDescriptors';

describe('useSetupWorkflow — pure functions', () => {
  describe('stepState', () => {
    it('returns done for steps before currentStep', () => {
      expect(stepState(STEP_NODE, STEP_MODULES)).toBe('done');
      expect(stepState(STEP_NODE, STEP_MS_AUTH)).toBe('done');
      expect(stepState(STEP_MODULES, STEP_MS_AUTH)).toBe('done');
    });

    it('returns active for the current step', () => {
      expect(stepState(STEP_NODE, STEP_NODE)).toBe('active');
      expect(stepState(STEP_MODULES, STEP_MODULES)).toBe('active');
      expect(stepState(STEP_MS_AUTH, STEP_MS_AUTH)).toBe('active');
    });

    it('returns pending for steps after currentStep', () => {
      expect(stepState(STEP_MODULES, STEP_NODE)).toBe('pending');
      expect(stepState(STEP_MS_AUTH, STEP_NODE)).toBe('pending');
      expect(stepState(STEP_MS_AUTH, STEP_MODULES)).toBe('pending');
    });

    it('all steps are done when currentStep is STEP_DONE', () => {
      expect(stepState(STEP_NODE, STEP_DONE)).toBe('done');
      expect(stepState(STEP_MODULES, STEP_DONE)).toBe('done');
      expect(stepState(STEP_MS_AUTH, STEP_DONE)).toBe('done');
      expect(stepState(STEP_DEPLOY, STEP_DONE)).toBe('done');
    });
  });

  describe('step constants', () => {
    it('required steps are sequential from 0 to 4', () => {
      expect(STEP_NODE).toBe(0);
      expect(STEP_MODULES).toBe(1);
      expect(STEP_MS_AUTH).toBe(2);
      expect(STEP_DEPLOY).toBe(3);
      expect(STEP_DONE).toBe(4);
    });

    it('optional steps are outside the main pipeline range', () => {
      expect(STEP_DOCKER).toBe(100);
      expect(STEP_GHCR).toBe(101);
    });
  });
});
