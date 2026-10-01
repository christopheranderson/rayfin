/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Web extension entry point — re-exports the shared activate/deactivate.
// When desktop-only Node.js code is added to extension.ts, split this into
// a browser-safe subset instead of re-exporting.
export { activate, deactivate } from '../extension';
