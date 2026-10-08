import { Command } from 'commander';

import { functionsInitCommand } from './functions-init.js';

export const functions = () =>
  new Command('functions')
    .description('Manage Rayfin functions')
    .addCommand(functionsInitCommand);

export const functionsCommand = functions();
