import { Command, Option } from 'commander';

import { getVersionString } from './utils/version.js';

/**
 * Selects init-only registration without interpreting command arguments.
 * Commander still owns validation; ambiguous prefixes use the full graph.
 * @internal `argv` includes the executable and entry-script paths.
 */
export function isInitInvocation(argv: readonly string[]): boolean {
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'init') return true;
    if (['-y', '--yes', '--json', '--verbose'].includes(arg)) continue;
    if (arg === '--output') {
      i += 1;
      if (i >= argv.length) return false;
      continue;
    }
    if (arg.startsWith('--output=')) continue;
    return false;
  }
  return false;
}

/** @internal Root options shared with invocation selection tests. */
export function createRootCommand(): Command {
  return (
    new Command()
      .name('rayfin')
      .description(
        'CLI for the Rayfin platform - Data API Builder tooling and services'
      )
      .version(getVersionString())
      .option('-y, --yes', 'Auto-accept all confirmation prompts', false)
      // resolveRootOutputFlags OR-merges these with subcommand flags; using
      // optsWithGlobals would let local false defaults hide root selections.
      .addOption(
        new Option(
          '--output <mode>',
          'Output format for the invoked subcommand'
        ).choices(['interactive', 'plain', 'json'])
      )
      .addOption(
        new Option(
          '--verbose',
          'Enable verbose output for the invoked subcommand'
        ).default(false)
      )
      .addOption(
        new Option(
          '--json',
          'Emit machine-readable JSON output from the invoked subcommand'
        ).default(false)
      )
      .showSuggestionAfterError(true)
      .showHelpAfterError('(add --help for additional information)')
  );
}
