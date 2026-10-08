/**
 * clean.js — Remove target/ directory to reset for a fresh build.
 */
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const targetDir = resolve(import.meta.dirname, '..', 'target');

if (existsSync(targetDir)) {
  rmSync(targetDir, { recursive: true, force: true });
  console.log('Cleaned target/');
} else {
  console.log('target/ does not exist, nothing to clean');
}
