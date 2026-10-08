import { describe, expect, it } from 'vitest';

import { envCommand } from '../env/env.js';

describe('env command', () => {
  it('should have refreshed option descriptions', () => {
    const frameworkOption = envCommand.options.find(
      (option) => option.long === '--framework'
    );
    const outputOption = envCommand.options.find(
      (option) => option.long === '--output'
    );
    const showOption = envCommand.options.find(
      (option) => option.long === '--show'
    );

    expect(frameworkOption?.description).toBe(
      'Target framework: vite, nextjs, or plain. Auto-detected from package.json if omitted'
    );
    expect(outputOption?.description).toBe(
      'Directory for .env.local, relative to project root. Default: project root'
    );
    expect(showOption?.description).toBe(
      'Print resolved public variables to stdout and exit without writing'
    );
  });
});
