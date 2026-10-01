/**
 * Standalone smoke test for the scripted-agent strategies. Runs every
 * task on each transport once, prints score + tags + first 200 chars of
 * the synthesized answer. Useful to validate new tasks before paying for
 * the (expensive) Copilot matrix.
 */
import { CliAdapter } from './cli-adapter.js';
import { McpAdapter } from './mcp-adapter.js';
import { buildValidationContext, runScriptedTask } from './scripted-agent.js';
import { TASKS } from './tasks.js';

async function main(): Promise<void> {
  for (const transport of ['cli', 'mcp'] as const) {
    const adapter = transport === 'cli' ? new CliAdapter() : new McpAdapter();
    await adapter.start();
    if (transport === 'mcp') {
      try {
        await adapter.call({ name: 'list_docs', arguments: {} });
      } catch {
        /* ignore */
      }
    }
    console.log(`\n=== ${transport.toUpperCase()} ===`);
    for (const task of TASKS) {
      try {
        const result = await runScriptedTask(task, adapter);
        const validation = task.validate(buildValidationContext(result));
        const status =
          validation.score >= 0.75
            ? '✅'
            : validation.score >= 0.5
              ? '🟡'
              : '❌';
        console.log(
          `${status} ${task.id} score=${validation.score.toFixed(2)} calls=${result.toolCalls.length} tags=[${validation.tags.join(',')}]`
        );
        if (validation.score < 0.75) {
          console.log(`   notes: ${validation.notes.join('; ')}`);
          console.log(
            `   answer (first 240 chars): ${result.finalAnswer.slice(0, 240).replace(/\n/g, ' ')}`
          );
        }
      } catch (err) {
        console.log(
          `❌ ${task.id} threw: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    await adapter.shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
