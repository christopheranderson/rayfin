import { bootstrapEnvironmentConfig } from '@microsoft/rayfin-tools-common/_internal/env-config';

import { createRootCommand, isInitInvocation } from './root-command.js';
import { installCommanderHooks } from './telemetry/index.js';

// Hydrate process.env.RAYFIN_* from any persisted environmentConfig in
// ~/.rayfin/auth.json before downstream modules read those env vars.
//
// Done at the entry point (not inside RayfinAuth) because the five
// `RAYFIN_*` env vars are read by both auth code (RAYFIN_AUTHORITY_HOST,
// RAYFIN_CLIENT_ID, RAYFIN_FABRIC_SCOPE) and non-auth code
// (RAYFIN_FABRIC_API_URL and RAYFIN_FABRIC_PORTAL_URL, read by
// `getFabricSettings()` in `@microsoft/rayfin-tools-common`).
// Constructing RayfinAuth lazily happens after several command handlers
// have already resolved Fabric settings, so hiding hydration in its
// constructor would leave those reads stale.
//
// Bootstrap writes nothing to stdout, so it cannot corrupt --json
// command output. Diagnostics for a corrupt/unreadable auth.json go to
// stderr (intentionally — the user's persisted overrides would
// silently fail to take effect, which is worth surfacing). Inherited
// shell exports always win; missing/malformed state is silent.
bootstrapEnvironmentConfig();

const program = createRootCommand();

const { createInitCommand } = await import('./commands/init.js');
program.addCommand(createInitCommand());

// Runtime command registration may read project settings. Creating a child
// must not depend on the enclosing project's deployment configuration.
if (!isInitInvocation(process.argv)) {
  const [
    { devCommand },
    { upCommand },
    { secretCommand },
    { functionsCommand },
    { connectorCommand },
    { envCommand },
    { loginCommand },
    { logoutCommand },
    { docsCommand },
  ] = await Promise.all([
    import('./commands/dev/dev.js'),
    import('./commands/up/up.js'),
    import('./commands/secret.js'),
    import('./commands/functions/functions.js'),
    import('./commands/connector/connector.js'),
    import('./commands/env/env.js'),
    import('./commands/login.js'),
    import('./commands/logout.js'),
    import('./commands/docs/docs.js'),
  ]);
  for (const command of [
    devCommand,
    upCommand,
    secretCommand,
    functionsCommand,
    connectorCommand,
    envCommand,
    loginCommand,
    logoutCommand,
    docsCommand,
  ]) {
    program.addCommand(command);
  }
}

// Install telemetry hooks on all commands.
installCommanderHooks(program);

export const cli = program;
