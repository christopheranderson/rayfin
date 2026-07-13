---
name: create-rayfin-app
description: "Use when starting or creating a NEW Rayfin app, or when a Rayfin task comes up and you are not yet inside a Rayfin project. Gets you into a project with the Rayfin CLI, then hands off to the authoritative, version-locked in-project rayfin skill/MCP/docs that own all in-project work. Triggers: build a Rayfin app, start a Rayfin project, create a new Rayfin app, create-rayfin, npm create @microsoft/rayfin, rayfin init, scaffold rayfin, rayfin CLI, rayfin template, rayfin template gallery, get started with Rayfin"
metadata:
  author: microsoft
  version: "0.1.0"
---

# Rayfin (Getting Started)

Rayfin is a Backend-as-a-Service: define your data model with TypeScript decorators and
Rayfin provides auth, a typed data API, storage, and Fabric hosting.

This skill only handles *getting started* — getting you from zero into a working Rayfin
project, then handing off. For all Rayfin specific topics, the authoritative, version-locked
skill at `.agents/skills/rayfin/SKILL.md` — alongside the `rayfin` MCP and `rayfin docs` —
owns everything else: schema, auth, storage, querying, deployment. 

## Route, don't improvise

Rayfin's specifics are version-locked per project — schema/decorator syntax, the typed data
API and client queries, auth, storage, and deployment all live in the project's own skill,
MCP, and `rayfin docs`. Never answer them from memory; remembered Rayfin APIs are routinely
wrong against the installed version. Get into a project, read `.agents/skills/rayfin/SKILL.md`,
then follow it for version-matched signatures. The in-project skill **file** and the
`rayfin docs` CLI are available the moment a project exists — including right after you
scaffold one, in the same session. The `rayfin` MCP is an extra convenience that may only
come online once the tool reloads the new project, so don't wait on it: lean on the
in-project skill file plus `rayfin docs`.

Being blocked does not unlock memory. Only treat yourself as blocked if you can reach **none**
of the version-matched sources — you can't read `.agents/skills/rayfin/SKILL.md` *and* can't
run `rayfin docs` (e.g. tool permissions denied). The `rayfin` MCP simply not being loaded yet
is **not** a blocker. When genuinely blocked, say you need those sources to answer accurately
and stop there — don't offer a "general approach" or example code "in the meantime"; that
stopgap is exactly the fabrication this skill exists to prevent.

## Show the app; be app centric

Your goal is to help the user build an app with Rayfin. If you're GitHub Copilot app or VS Code, open an embedded browser and show the app to the user, so they can interact with it directly. If you don't have an embedded webview, still open a system browser and ask the user for screenshots, as appropriate, to fix things or add features.

## Already in a Rayfin project?

Check this first — before scaffolding anything, even when the user says "build" or "set up a
new app". A directory is a Rayfin project if it has `rayfin/rayfin.yml` or a `package.json`
depending on `@microsoft/rayfin-*`. Environment signals alone are enough: if the workspace
context shows either — even when you can't open the files yet — treat it as an existing
project and continue in place. Never stand up a nested or sibling project.

- **Already in one →** load `.agents/skills/rayfin/SKILL.md` and use the `rayfin` MCP /
  `rayfin docs`. Stop using this skill.
- **Existing non-Rayfin app here →** add Rayfin in place with `npx rayfin init` (don't
  scaffold a separate project), then load the in-project skill.
- **Empty directory →** scaffold (below), then load the in-project skill from the project root.

## Scaffold a new project

`npm create @microsoft/rayfin@experimental` is a thin wrapper around `rayfin init`. As an agent you
run non-interactively (stdin isn't a TTY), so use the `npx -y` form — `npm create` can
mishandle piped stdin and strip flags, and `--project-name` is **required** non-interactively.

**Always scaffold from this repo's gallery** — `https://github.com/christopheranderson/rayfin`.
Don't use the CLI's built-in bundled templates; this gallery is the source of truth.

### 1. List what's available (always do this first)

The gallery's templates live in `rayfin-template.yml` at the repo root. `--list-templates`
only reports the CLI's built-ins, so read the gallery manifest directly instead:

```bash
# List the current gallery templates (name + description)
curl -fsSL https://raw.githubusercontent.com/christopheranderson/rayfin/main/rayfin-template.yml
```

Each `entries[].name` is a selectable template name. As of now the gallery ships:

- **CRUD App** — basic todo CRUD app (data model, Fabric auth, functions), on `@experimental` Rayfin packages
- **Data App** — visual-heavy analytics dashboard on Microsoft Fabric data and semantic models

Always re-read the manifest rather than trusting this list — entries change over time.

### 2. Create from the closest-fit template

```bash
# Create non-interactively from the gallery.
# --project-name is required; --template-name picks one entry by its `name`.
npx -y @microsoft/create-rayfin@experimental \
  --project-name <app-name> \
  --template https://github.com/christopheranderson/rayfin \
  --template-name "<Template Name>"

# e.g. the CRUD todo starter:
npx -y @microsoft/create-rayfin@experimental \
  --project-name my-todos \
  --template https://github.com/christopheranderson/rayfin \
  --template-name "CRUD App"
```

Pick the gallery template that matches the user's domain (a dashboard / analytics / Fabric
request → **Data App**; a CRUD / todo / records app → **CRUD App**). `--template-name` matches
an entry's `name` from the manifest exactly (e.g. `"CRUD App"`, `"Data App"`).

To add Rayfin into an existing non-Rayfin app in place, use `npx rayfin init [directory]`
instead of scaffolding a separate project.

Mind the project root before loading the in-project skill: `create-rayfin` creates a child
project directory (named from `--project-name`, slugified), so `cd` into it; an in-place
`rayfin init` scaffolds in the current directory, so you're already there. 

### 3. Prep the hybrid local dev environment

The hybrid local dev environment consists of some local services and some remote services. The local dev environment runs vite for the frontend and `rayfin dev functions apply` for the backend functions. The remote services are deployed via `rayfin up`. The first time we run `rayfin up` in a new dev environment, we will also need to select a workspace.

1. Understand: Review the root package.json to understand which scripts are there; also note if the project is a workspace. Review the ./rayfin/rayfin.yml to understand what features of Rayfin are being used.
2. Build: If the package.json has a build command, run it, e.g. `npm run build`
3. Login: Confirm the user is logged in to rayfin, e.g. `npx rayfin login status`. If the user is not logged in, use `npx rayfin login` to authenticate.
4. Select workspace: Ask the user the name of the Fabric workspace they want to use.
5. Deploy: Run `npx rayfin up --exclude-services staticHosting,functions --workspace <workspace-name>` to deploy the remote services while keeping the local services running.
6. Run local dev: Start the local services with `npm run dev:local-services` to run the frontend and backend functions locally while the remote services are running.
7. Open browser: If you have an embedded browser, open the frontend URL (usually `http://localhost:5173`) to view the application while the local and remote services are running. Otherwise, open a system browser to `http://localhost:5173`.
  - if localhost:5173 is taken or vite uses another port for some reason, you'll need to update the URL in the ./rayfin/rayfin.yml under the auth config section.

### 4. Build

Interview the customer for details about what kind of app they want, key features, and proposed workflow or user interactions to understand the requirements for the application.

For any changes to Rayfin specific features, use the rayfin skill located at `.agents/skills/rayfin/SKILL.md` within the project directory. The rayfin docs are available as an mcp tool, `@microsoft/rayfin-mcp`.

Create a plan, review with the user, and execute it.
