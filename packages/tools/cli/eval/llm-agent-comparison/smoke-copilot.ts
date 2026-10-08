/**
 * Standalone smoke test for the Copilot CLI agent driver. Runs T1
 * (factual-dev-command) once on each transport and prints a quick
 * summary. Useful to validate the integration before wiring into the
 * full orchestrator.
 */
import { runCopilotTaskFull } from './copilot-agent.js';
import { TASKS } from './tasks.js';

async function main(): Promise<void> {
  const task = TASKS[0];
  for (const transport of ['cli', 'mcp', 'raw-docs'] as const) {
    console.log(`\n=== ${transport.toUpperCase()} ===`);
    const start = Date.now();
    try {
      const { result, copilot } = await runCopilotTaskFull(task, transport);
      console.log(`wall: ${Date.now() - start} ms`);
      console.log(`turns: ${copilot.turns}`);
      console.log(`tool requests: ${copilot.toolRequests.length}`);
      console.log(`input tokens:  ${copilot.inputTokens}`);
      console.log(`output tokens: ${copilot.outputTokens}`);
      console.log(`cached tokens: ${copilot.cachedTokens}`);
      console.log(`premium requests: ${copilot.premiumRequests}`);
      console.log(`session duration: ${copilot.sessionDurationMs} ms`);
      console.log(`final answer (first 400 chars):`);
      console.log(result.finalAnswer.slice(0, 400));
    } catch (err) {
      console.error(
        `FAILED: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
