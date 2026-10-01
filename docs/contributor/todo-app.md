# Todo App Contributor Guide

This guide is for Rayfin Contributors who need to run and validate the Todo App sample as part of local platform development.

Builders who simply want to explore the app should start with `/samples/todo-app/README.md`.

## Prerequisites

- .NET 8 SDK installed
- Rush toolchain bootstrapped in this repo (see `docs/contributor/setup.md`)

Follow the standard build instructions in `samples/todo-app/README.md` for installing Node.js dependencies and running the sample with the Rayfin CLI and Docker.

This guide only covers the additional steps required to use the locally built .NET WebService instead of `npm run rayfin:dev`.

## 1. Run the Rayfin WebService backend

Run the .NET WebService so the Todo App can call a live Rayfin backend.
Make sure you have completed the backend prerequisites and configuration described in `packages/host/README.md` before starting the service.

From the repository root:

```bash
cd packages/host/Microsoft.Rayfin.WebService
DOTNET_ENVIRONMENT=Development dotnet run
```

This starts the WebService with Data API Builder and exposes the Rayfin endpoint on `http://localhost:5168`.

Keep this terminal running while you use the Todo App.

## 2. Run the Todo App against the WebService

In a new terminal, from the repository root:

```bash
cd samples/todo-app
rushx dev:rayfin
```

This command:

- Ensures `VITE_SERVICE_MODE=rayfin` via the service-mode script
- Starts the Vite dev server for the Todo App

When the dev server starts it will print a local URL such as `http://localhost:5173`.

Open that URL in your browser.

## 3. Validate end-to-end behavior

Use this checklist when validating changes to the platform or sample:

1. Navigate to the Todo App URL from the previous step
2. Sign up as a new user
3. Sign in with the new account
4. Create several todos and verify they appear in the list
5. Mark one or more todos complete and verify they move to the completed view
6. Delete a todo and verify it is removed
7. Create and edit categories, then filter the todo list by category and status
8. Upload a profile image and verify the header avatar updates

All of these operations should use the Rayfin WebService backend you started earlier.

## 4. When to prefer this guide

Use this guide when:

- You are changing Rayfin host or SDK behavior and need a realistic UI to validate it
- You are debugging end-to-end issues between the WebService and the Todo App
