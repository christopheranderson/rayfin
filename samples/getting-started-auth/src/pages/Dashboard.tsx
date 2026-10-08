import {
  BotIcon,
  BookOpenIcon,
  CodeIcon,
  DatabaseIcon,
  LogOutIcon,
  ShieldIcon,
  SparklesIcon,
} from 'lucide-react';

import { TodoForm } from '@/components/TodoForm';
import { TodoList } from '@/components/TodoList';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/AuthContext';
import { useTodos } from '@/hooks/useTodos';

const FEATURES = [
  {
    icon: DatabaseIcon,
    iconBg: 'bg-blue-100',
    iconColor: 'text-blue-600',
    title: 'Built-in database, ready to go',
    description: (
      <>
        Your database is up and running. The milestones above are synced from
        it.
      </>
    ),
  },
  {
    icon: BotIcon,
    iconBg: 'bg-orange-100',
    iconColor: 'text-orange-600',
    title: 'Editable by an agent',
    description:
      'Your app is designed to be editable by an agent. When you are done reading this, go give it a try.',
  },
  {
    icon: ShieldIcon,
    iconBg: 'bg-pink-100',
    iconColor: 'text-pink-600',
    title: 'Public by default, add auth if needed',
    description:
      "To share your app (in Private Preview), invite users to your app's Fabric workspace.",
  },
  {
    icon: SparklesIcon,
    iconBg: 'bg-yellow-100',
    iconColor: 'text-yellow-600',
    title: 'Private Preview with more to come',
    description:
      'We have lots of features in the works, including Fabric data connections, storage, real-time services, and native agent support.',
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
  const { todos, loading, error, addTodo, toggleTodo } = useTodos();

  const handleSignOut = async () => {
    await signOut();
  };

  const handleToggle = async (id: string, isCompleted: boolean) => {
    try {
      await toggleTodo(id, isCompleted);
    } catch {
      // toggle failed silently
    }
  };

  const handleAdd = async (title: string) => {
    await addTodo(title);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <span className="text-lg font-semibold">Getting Started</span>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">{user?.email}</span>
            <Button variant="ghost" size="sm" onClick={handleSignOut}>
              <LogOutIcon className="mr-2 h-4 w-4" />
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-16">
        <div className="text-center mb-16">
          <h1 className="text-5xl font-bold">
            Welcome to your app{' '}
            <span role="img" aria-label="party">
              🎉
            </span>
          </h1>
        </div>

        {/* Journey Card */}
        <div className="mb-16">
          <div className="bg-white rounded-3xl shadow-xl p-8">
            <h2 className="text-3xl font-bold mb-6 text-center">
              Your journey so far
            </h2>

            {error && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <TodoList todos={todos} loading={loading} onToggle={handleToggle} />

            <div className="mt-6">
              <TodoForm onAdd={handleAdd} />
            </div>
          </div>
        </div>

        {/* About your app */}
        <div className="mb-16 -mx-8">
          <h2 className="text-3xl font-bold text-center mb-8">
            About your app
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-8">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="flex gap-4">
                <div
                  className={`flex-shrink-0 w-12 h-12 ${feature.iconBg} rounded-2xl flex items-center justify-center`}
                >
                  <feature.icon className={`w-5 h-5 ${feature.iconColor}`} />
                </div>
                <div className="flex-1">
                  <h3 className="text-gray-900 font-bold">{feature.title}</h3>
                  <p className="text-gray-600 text-sm mt-1">
                    {feature.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Documentation */}
        <div>
          <h2 className="text-3xl font-bold text-center mb-8">Documentation</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {DOCS.map((doc) => (
              <div
                key={doc.title}
                className="bg-white rounded-2xl border border-gray-200 p-6 flex flex-col"
              >
                <div
                  className={`w-12 h-12 ${doc.iconBg} rounded-2xl flex items-center justify-center mb-4`}
                >
                  <doc.icon className={`w-5 h-5 ${doc.iconColor}`} />
                </div>
                <h3 className="text-gray-900 font-bold text-lg">{doc.title}</h3>
                <p className="text-gray-600 text-sm mt-2 flex-1">
                  {doc.description}
                </p>
                <a
                  href={doc.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 w-full py-2.5 border border-gray-200 rounded-xl text-center text-gray-700 font-medium hover:bg-gray-50 transition-colors block"
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
