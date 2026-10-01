/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { makeStyles, tokens } from '@fluentui/react-components';

/**
 * Typography and color utility styles shared across all webviews.
 *
 * New views should import these `muted` and `eyebrow` styles instead of
 * re-declaring the same tokens.
 */
export const useSharedStyles = makeStyles({
  muted: {
    color: tokens.colorNeutralForeground3,
  },

  eyebrow: {
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: tokens.colorBrandForeground1,
    fontWeight: 700,
  },
});
