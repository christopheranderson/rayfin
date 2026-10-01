---
agent: agent
description: 'Get the todo-app sample up and running with locally built Rayfin running.'
tools: ['runCommands', 'runTasks', 'edit', 'search', 'new', 'usages', 'problems', 'changes', 'testFailure', 'fetch', 'todos', 'runSubagent', 'runTests']
---

Follow the instructions exactly. If there is an issue, stop. Explain what may have happened and suggest a fix.

INSTRUCTIONS:
- Start the Rayfin backend (locally built). Use the VS Code task with level "build" to build everything.
- Start the Rayfin web service dependencies. Use the VS Code task with label "rayfin:dev-setup" to start the dependencies.
- Start the Rayfin web service. Use the VS Code task with label "start:web-service" to start the web service.
- Start the todo-app VITE server. Use the VS Code task with label "todo-app:dev" to start the VITE server.
- Use playwright MCP to navigate to todo-app and validate the application is running.

**Always run VS Code tasks from the repo root**.
