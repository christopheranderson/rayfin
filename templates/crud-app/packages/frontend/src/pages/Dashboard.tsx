import {
  BookOpenIcon,
  BotIcon,
  CodeIcon,
  DatabaseIcon,
  HeartPulseIcon,
  LogOutIcon,
  ShieldIcon,
  SparklesIcon,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { TodoForm } from '@/components/TodoForm';
import { TodoList } from '@/components/TodoList';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/AuthContext';
import { useTodos } from '@/hooks/useTodos';
import { ServiceContainer } from '@/services/ServiceContainer';

const FEATURES = [
  {
    icon: DatabaseIcon,
    iconBg: 'bg-blue-100',
    iconColor: 'text-blue-600',
    title: 'Built-in database, ready to go',
    description:
      'Your tasks are stored in the Rayfin data layer. Add, complete, and delete items — every change is persisted through the typed client.',
  },
  {
    icon: SparklesIcon,
    iconBg: 'bg-yellow-100',
    iconColor: 'text-yellow-600',
    title: 'Serverless functions wired up',
    description:
      'Completing a task calls the completeTodo function, and the health check below calls healthCheck — both fully typed end to end.',
  },
  {
    icon: BotIcon,
    iconBg: 'bg-orange-100',
    iconColor: 'text-orange-600',
    title: 'Editable by an agent',
    description:
      'This app is designed to be extended by GitHub Copilot. Ask it to add a field, a page, or a new function to get started.',
  },
  {
    icon: ShieldIcon,
    iconBg: 'bg-pink-100',
    iconColor: 'text-pink-600',
    title: 'Auth built in',
    description:
      'Sign-in runs through Microsoft Fabric in production and the local auth proxy during development, so your data stays per-user.',
  },
];

const DOCS = [
  {
    icon: BookOpenIcon,
    iconBg: 'bg-teal-100',
    iconColor: 'text-teal-600',
    title: 'Quick start guide',
    description:
      'Learn how to create a project, define your data models, and deploy your app in just a few steps.',
    buttonLabel: 'View guide',
    url: 'https://go.microsoft.com/fwlink/?linkid=2356937',
  },
  {
    icon: CodeIcon,
    iconBg: 'bg-teal-100',
    iconColor: 'text-teal-600',
    title: 'SDK reference',
    description:
      'Use our Typescript SDK to define your backend and connect your app.',
    buttonLabel: 'View SDK docs',
    url: 'https://go.microsoft.com/fwlink/?linkid=2356833',
  },
];

export function Dashboard() {
  const { user, signOut } = useAuth();
  const { todos, loading, error, addTodo, toggleTodo, deleteTodo } = useTodos();
  const [checkingHealth, setCheckingHealth] = useState(false);

  const handleSignOut = async () => {
    await signOut();
  };

  const handleToggle = async (id: string, isCompleted: boolean) => {
    try {
      await toggleTodo(id, isCompleted);
    } catch {
      // Error is surfaced via the `error` state from useTodos.
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteTodo(id);
    } catch {
      // Error is surfaced via the `error` state from useTodos.
    }
  };

  const handleAdd = async (title: string) => {
    await addTodo(title);
  };

  const handleHealthCheck = async () => {
    setCheckingHealth(true);
    try {
      const result =
        await ServiceContainer.getInstance().functionsService.healthCheck();
      toast.success('Health check passed', {
        description: `ok=${result.ok} · ${new Date(
          result.timestamp
        ).toLocaleTimeString()}`,
      });
    } catch (err) {
      toast.error('Health check failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setCheckingHealth(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b bg-white">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <span className="text-lg font-semibold">Workspace Todos</span>
          <div className="flex items-center gap-2 sm:gap-4">
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {user?.email}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleHealthCheck}
              disabled={checkingHealth}
            >
              <HeartPulseIcon className="mr-2 h-4 w-4" />
              {checkingHealth ? 'Checking...' : 'Health check'}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleSignOut}>
              <LogOutIcon className="mr-2 h-4 w-4" />
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12">
        <div className="mb-10 text-center">
          <h1 className="text-4xl font-bold">
            Your tasks{' '}
            <span role="img" aria-label="sparkles">
              ✨
            </span>
          </h1>
          <p className="mt-2 text-muted-foreground">
            A starting point for your Rayfin app — data, functions, auth, and a
            modern UI, ready to build on.
          </p>
        </div>

        <div className="mb-16">
          <div className="rounded-3xl bg-white p-6 shadow-xl sm:p-8">
            {error && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="mb-6">
              <TodoForm onAdd={handleAdd} />
            </div>

            <TodoList
              todos={todos}
              loading={loading}
              onToggle={handleToggle}
              onDelete={handleDelete}
            />
          </div>
        </div>

        <div className="mb-16">
          <h2 className="mb-8 text-center text-3xl font-bold">
            What&apos;s in the box
          </h2>
          <div className="grid grid-cols-1 gap-x-12 gap-y-8 md:grid-cols-2">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="flex gap-4">
                <div
                  className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl ${feature.iconBg}`}
                >
                  <feature.icon className={`h-5 w-5 ${feature.iconColor}`} />
                </div>
                <div className="flex-1">
                  <h3 className="font-bold text-gray-900">{feature.title}</h3>
                  <p className="mt-1 text-sm text-gray-600">
                    {feature.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h2 className="mb-8 text-center text-3xl font-bold">Documentation</h2>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {DOCS.map((doc) => (
              <div
                key={doc.title}
                className="flex flex-col rounded-2xl border border-gray-200 bg-white p-6"
              >
                <div
                  className={`mb-4 flex h-12 w-12 items-center justify-center rounded-2xl ${doc.iconBg}`}
                >
                  <doc.icon className={`h-5 w-5 ${doc.iconColor}`} />
                </div>
                <h3 className="text-lg font-bold text-gray-900">{doc.title}</h3>
                <p className="mt-2 flex-1 text-sm text-gray-600">
                  {doc.description}
                </p>
                <a
                  href={doc.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 block w-full rounded-xl border border-gray-200 py-2.5 text-center font-medium text-gray-700 transition-colors hover:bg-gray-50"
                >
                  {doc.buttonLabel}
                </a>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
