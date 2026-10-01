import { Command } from 'commander';

import { connectorAddCommand } from './connector-add.js';
import { connectorInspectCommand } from './connector-inspect.js';
import { connectorInvokeCommand } from './connector-invoke.js';
import { connectorListCommand } from './connector-list.js';
import { connectorRemoveCommand } from './connector-remove.js';
import { connectorSearchCommand } from './connector-search.js';
import { connectorTypesCommand } from './connector-types.js';

export const connectorCommand = new Command('connector')
  .description('Manage external data connectors')
  .addCommand(connectorInvokeCommand)
  .addCommand(connectorInspectCommand)
  .addCommand(connectorTypesCommand)
  .addCommand(connectorAddCommand)
  .addCommand(connectorListCommand)
  .addCommand(connectorSearchCommand)
  .addCommand(connectorRemoveCommand);
