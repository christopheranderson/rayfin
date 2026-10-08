# Notes App - Rayfin Platform Sample

A modern note-taking application built with React, TypeScript, and the Rayfin platform. This sample demonstrates clean architecture patterns, service-based design, and Rayfin's code-first approach with TypeScript decorators.

## Table of Contents

- [Notes App - Rayfin Platform Sample](#notes-app---rayfin-platform-sample)
  - [Table of Contents](#table-of-contents)
  - [Features](#features)
  - [Architecture](#architecture)
  - [Development Workflow](#development-workflow)
  - [Project Structure](#project-structure)
  - [Data Models](#data-models)
    - [Note Entity](#note-entity)
    - [Notebook Entity](#notebook-entity)
  - [Development Patterns](#development-patterns)
    - [Service Container Pattern](#service-container-pattern)
    - [React Hooks Pattern](#react-hooks-pattern)
    - [Entity Decorators](#entity-decorators)
  - [Next Steps](#next-steps)
  - [Technologies Used](#technologies-used)

## Features

- **Rich Note Editor**: Create and edit notes with Markdown support
- **Organization**: Organize notes into notebooks with color coding
- **Search & Filter**: Quick search through note titles and content
- **Pin Important Notes**: Pin frequently accessed notes for easy access
- **Responsive Design**: Modern UI built with Tailwind CSS
- **Type Safety**: Full TypeScript support with Rayfin decorators

## Architecture

The Notes App uses the following clean architecture patterns:

- **Service-based architecture** with dependency injection
- **Rayfin platform integration** for data and authentication
- **Modern React hooks** for state management
- **TypeScript decorators** for code-first configuration
- **Tailwind CSS** for responsive UI design

## Development Workflow

Once set up, your typical development workflow:

```bash

# Deploy to fabric and start local vite
npm run dev

# Make changes to entities in rayfin/data/
# Update schema
npx rayfin up db apply
```

## Project Structure

```text
src/
├── models/           # Frontend data models (AuthUser)
├── services/         # Service layer with abstractions
│   ├── interfaces/   # Service contracts (INoteService, IAuthService, etc.)
│   └── rayfin/       # Rayfin service implementations
├── hooks/            # React hooks (useAuth, useNotes, useNotebooks)
├── components/       # UI components (LoginForm, NoteEditor, etc.)
rayfin/
└── data/            # Rayfin entity models with decorators
    ├── Note.ts      # Note entity with typed decorators
    ├── Notebook.ts  # Notebook entity with relationships
    └── schema.ts    # Type-safe schema definition
```

## Data Models

### Note Entity

- **Title & Content**: Rich text with Markdown support
- **Organization**: Belongs to notebooks, can have multiple tags
- **Status**: Pin important notes, archive completed ones
- **Timestamps**: Track creation and modification dates

### Notebook Entity

- **Organization**: Group related notes together
- **Default**: Each user has a default notebook

## Development Patterns

### Service Container Pattern

The app uses dependency injection for service management:

```typescript
// Create Rayfin service container
const container = ServiceContainer.create();
```

### React Hooks Pattern

Custom hooks encapsulate business logic:

- `useAuth()` - Authentication state and operations
- `useNotes(userId)` - Note management for a user
- `useNotebooks(userId)` - Notebook management

### Entity Decorators

Rayfin decorators define the data model:

```typescript
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class Note {
  @uuid() id!: string;
  @text() title!: string;
  @text() content!: string;
  @set('markdown', 'html', 'plaintext') contentType!: 'markdown' | 'html' | 'plaintext';
  // ...more fields
}
```

## Next Steps

1. **Rich Text Editor**: Integrate a WYSIWYG editor for enhanced content creation
2. **Email Verification**: Enable services.auth.email.enabled in the file `rayfin/rayfin.yml` and update the workflow to require email verification before signing in
3. **Share Notes**: Add note sharing features
4. **Mobile App**: Extend to React Native for mobile access
5. **Export/Import**: Add note export to various formats (PDF, Word, etc.)

## Technologies Used

- **Frontend**: React 19, TypeScript 5.8+, Tailwind CSS
- **State Management**: React Hooks, Custom Hooks
- **Architecture**: Service Layer, Dependency Injection
- **Data Platform**: Rayfin with TypeScript Decorators
- **Build**: Vite, ESLint, Prettier
