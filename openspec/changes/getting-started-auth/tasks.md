## 1. Project Scaffolding

- [x] 1.1 Copy `samples/welcome-app-react-auth/` to `samples/getting-started-auth/`
- [x] 1.2 Update `package.json` with new template metadata (name, displayName, description) and remove username/password auth deps
- [x] 1.3 Update `rayfin/rayfin.yml` to disable password auth and set Fabric-only auth
- [x] 1.4 Create `.templateignore` to exclude AGENTS.md from template output

## 2. Data Model

- [x] 2.1 Replace `rayfin/data/Timestamp.ts` with `rayfin/data/Todo.ts` entity (id, title, isCompleted, createdAt, user_id)
- [x] 2.2 Update `rayfin/data/schema.ts` to export Todo entity and schema type

## 3. Service Layer

- [x] 3.1 Replace `ITimestampService.ts` with `ITodoService.ts` interface (getTodos, createTodo, updateTodo, deleteTodo)
- [x] 3.2 Replace `RayfinTimestampService.ts` with `RayfinTodoService.ts` using DataApi fluent interface
- [x] 3.3 Update `ServiceContainer.ts` to wire up TodoService instead of TimestampService
- [x] 3.4 Remove `RayfinUsernameAuthService.ts` and username/password auth from `RayfinAuthService.ts` builder

## 4. React Hooks

- [x] 4.1 Replace `useTimestamps.ts` hook with `useTodos.ts` hook (CRUD operations + milestone seeding logic)
- [x] 4.2 Update `AuthContext.tsx` to remove username auth capability flags

## 5. UI Components

- [x] 5.1 Create `TodoItem.tsx` component with shadcn checkbox, title display, and delete button
- [x] 5.2 Create `TodoForm.tsx` component with shadcn input for adding new todos
- [x] 5.3 Create `TodoList.tsx` component rendering the list of TodoItems
- [x] 5.4 Create `MilestoneCard.tsx` component showing "Your journey so far" with milestone tasks
- [x] 5.5 Update `Dashboard.tsx` to show welcome heading, MilestoneCard, and TodoList
- [x] 5.6 Update `AuthPage.tsx` and remove `SignInForm.tsx`/`SignUpForm.tsx`/`ForgotPassword.tsx`/`ResetPassword.tsx` — replace with Fabric-only sign-in button
- [x] 5.7 Remove `TimestampTable.tsx` component

## 6. Documentation

- [x] 6.1 Write `README.md` with production-first workflow (rayfin up + dev:prod as primary, local dev as secondary)
- [x] 6.2 Write `AGENTS.md` with production-first quickstart and command table
- [x] 6.3 Update `samples/README.md` to list the new getting-started-auth sample

## 7. Template Registration

- [x] 7.1 Add project to rush.json and verify template metadata in package.json
- [x] 7.2 Verify template metadata in package.json is correct for CLI discovery

## 8. Validation

- [x] 8.1 Verify the app builds (`npm run build`)
- [x] 8.2 Verify `rayfin.yml` config is valid
- [x] 8.3 Verify lint passes (`npm run lint`)
