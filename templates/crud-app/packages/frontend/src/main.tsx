import { createSessionFromTokenResponse } from '@microsoft/rayfin-auth/_internal';
import {
  ensureSignedInWithFabric,
  bridgeFabricCallback,
  type FabricAuthOptions,
} from '@microsoft/rayfin-auth-provider-fabric';
import { RayfinClient } from '@microsoft/rayfin-client';
import type { TodoAppSchema } from '@workspace-todo-app/data';
import type { Todo } from '@workspace-todo-app/data';
import type { TodoFunctionsSchema } from '@workspace-todo-app/functions';
import {
  resolveRayfinConfig,
  isLocalDev,
  hydrateFabricSessionFromProxy,
  hydrateFabricSessionFromProxyIfCached,
  fabricProxyLogout,
  type FabricProxyOptions,
} from '@workspace-todo-app/local-dev';
import type { Image } from '@workspace-todo-app/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// `resolveRayfinConfig()` picks the backend base URL for the current runtime:
//   • local dev (vite)   → same-origin '/.rayfin' (proxied by rayfinLocalDev)
//   • production build    → absolute VITE_RAYFIN_API_URL (existing mechanism)
// Function calls use the SDK's default path either way; in dev the proxy decides
// whether each one runs against a local `func` host or the remote backend.
const { baseUrl, publishableKey } = resolveRayfinConfig();

const ALLOWED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
]);

function sanitizeMime(mime: string | null): string {
  if (mime && ALLOWED_IMAGE_MIMES.has(mime)) return mime;
  return 'image/png';
}

const client = new RayfinClient<TodoAppSchema, TodoFunctionsSchema>({
  baseUrl,
  publishableKey,
});

function getFabricOptions(): FabricAuthOptions | null {
  const workspaceId = import.meta.env.VITE_FABRIC_WORKSPACE_ID;
  const projectId = import.meta.env.VITE_FABRIC_ITEM_ID;
  const fabricPortalUrl = import.meta.env.VITE_FABRIC_PORTAL_URL;
  if (!workspaceId || !projectId || !fabricPortalUrl) return null;
  return {
    workspaceId,
    projectId,
    fabricPortalUrl,
    returnOrigin: window.location.origin,
  };
}

// Same Fabric config, shaped for the dev-server auth proxy. The proxy's bridge
// falls back to these same VITE_* vars, but passing them through keeps the
// system-browser login config-driven from the app side.
function getFabricProxyOptions(): FabricProxyOptions {
  return {
    workspaceId: import.meta.env.VITE_FABRIC_WORKSPACE_ID,
    projectId: import.meta.env.VITE_FABRIC_ITEM_ID,
    portalUrl: import.meta.env.VITE_FABRIC_PORTAL_URL,
    publishableKey,
  };
}

if (window.location.pathname === '/auth/callback') {
  bridgeFabricCallback();
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const colors = {
  bg: '#f5f5f7',
  surface: '#ffffff',
  border: '#e5e5e5',
  borderLight: '#f0f0f0',
  text: '#1d1d1f',
  textSecondary: '#6e6e73',
  textTertiary: '#aeaeb2',
  accent: '#0071e3',
  danger: '#ff3b30',
  success: '#34c759',
  priorityLow: '#34c759',
  priorityMedium: '#ff9500',
  priorityHigh: '#ff3b30',
  checkBg: '#e8e8ed',
};

const s = {
  page: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    background: colors.bg,
    minHeight: '100vh',
    color: colors.text,
    lineHeight: 1.5,
  } as React.CSSProperties,

  container: {
    maxWidth: 680,
    margin: '0 auto',
    padding: '24px 20px 48px',
  } as React.CSSProperties,

  loginWrapper: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
  } as React.CSSProperties,

  loginCard: {
    background: colors.surface,
    borderRadius: 16,
    padding: '48px 40px',
    textAlign: 'center' as const,
    boxShadow: '0 2px 20px rgba(0,0,0,0.06)',
    maxWidth: 380,
    width: '100%',
  } as React.CSSProperties,

  btnPrimary: {
    background: colors.accent,
    color: '#fff',
    border: 'none',
    borderRadius: 10,
    padding: '12px 28px',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    width: '100%',
  } as React.CSSProperties,

  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  } as React.CSSProperties,

  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  } as React.CSSProperties,

  btnGhost: {
    background: 'none',
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    padding: '6px 14px',
    fontSize: 13,
    color: colors.textSecondary,
    cursor: 'pointer',
  } as React.CSSProperties,

  formCard: {
    background: colors.surface,
    borderRadius: 14,
    padding: '16px 20px',
    marginBottom: 20,
    boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
    border: `1px solid ${colors.borderLight}`,
  } as React.CSSProperties,

  input: {
    flex: 1,
    border: 'none',
    outline: 'none',
    fontSize: 15,
    padding: '8px 0',
    background: 'transparent',
    color: colors.text,
  } as React.CSSProperties,

  fileLabel: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 34,
    height: 34,
    borderRadius: 8,
    background: colors.bg,
    cursor: 'pointer',
    fontSize: 18,
    color: colors.textSecondary,
    flexShrink: 0,
  } as React.CSSProperties,

  btnAdd: {
    background: colors.accent,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,

  preview: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    padding: '8px 12px',
    background: colors.bg,
    borderRadius: 8,
  } as React.CSSProperties,

  previewImg: {
    width: 48,
    height: 48,
    objectFit: 'cover' as const,
    borderRadius: 6,
  } as React.CSSProperties,

  listCard: {
    background: colors.surface,
    borderRadius: 14,
    boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
    border: `1px solid ${colors.borderLight}`,
    overflow: 'hidden',
  } as React.CSSProperties,

  todoItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    padding: '14px 20px',
    borderBottom: `1px solid ${colors.borderLight}`,
    cursor: 'pointer',
  } as React.CSSProperties,

  checkbox: (done: boolean) =>
    ({
      width: 22,
      height: 22,
      borderRadius: '50%',
      border: done ? 'none' : `2px solid ${colors.checkBg}`,
      background: done ? colors.success : 'transparent',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      cursor: 'pointer',
      color: '#fff',
      fontSize: 12,
    }) as React.CSSProperties,

  todoTitle: (done: boolean) =>
    ({
      fontSize: 15,
      fontWeight: 500,
      textDecoration: done ? 'line-through' : 'none',
      color: done ? colors.textTertiary : colors.text,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    }) as React.CSSProperties,

  priorityBadge: (priority: string) => {
    const c =
      priority === 'high'
        ? colors.priorityHigh
        : priority === 'medium'
          ? colors.priorityMedium
          : colors.priorityLow;
    return {
      fontSize: 11,
      fontWeight: 600,
      color: c,
      background: `${c}15`,
      padding: '1px 7px',
      borderRadius: 4,
      textTransform: 'uppercase' as const,
    } as React.CSSProperties;
  },

  error: {
    background: `${colors.danger}10`,
    color: colors.danger,
    borderRadius: 10,
    padding: '10px 16px',
    fontSize: 13,
    marginBottom: 16,
    border: `1px solid ${colors.danger}20`,
  } as React.CSSProperties,

  emptyState: {
    textAlign: 'center' as const,
    padding: '48px 20px',
  } as React.CSSProperties,

  smallBtn: {
    background: 'none',
    border: 'none',
    color: colors.textTertiary,
    cursor: 'pointer',
    fontSize: 16,
    padding: '4px 8px',
  } as React.CSSProperties,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatDate(d: string | Date): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getUserId(): string {
  return client.auth.getSession().user?.id ?? '';
}

// ---------------------------------------------------------------------------
// Login page
// ---------------------------------------------------------------------------
function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fabricOptions = getFabricOptions();

  const handleFabricLogin = async () => {
    if (!fabricOptions) return;
    setError(null);
    setBusy(true);
    try {
      await ensureSignedInWithFabric(client.auth, fabricOptions);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fabric sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  // WebView-friendly login: hands off to the dev-server auth proxy, which opens
  // the *system* browser to complete the real Fabric login (passkeys/SSO work
  // there), caches the raw Rayfin token, and returns it here. We then hydrate
  // the SDK session via the supported companion entry point.
  const handleProxyLogin = async () => {
    setError(null);
    setBusy(true);
    try {
      await hydrateFabricSessionFromProxy(
        (token) => createSessionFromTokenResponse(client.auth, token),
        getFabricProxyOptions()
      );
      onLogin();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'System-browser sign-in failed'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...s.page, ...s.loginWrapper }}>
      <div style={s.loginCard}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>✅</div>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 4px' }}>
          Workspace Todos
        </h1>
        <p
          style={{
            fontSize: 14,
            color: colors.textSecondary,
            margin: '0 0 32px',
          }}
        >
          Multi-package workspace sample powered by Rayfin
        </p>
        {error && (
          <div style={{ ...s.error, marginBottom: 20, textAlign: 'left' }}>
            {error}
          </div>
        )}
        {fabricOptions ? (
          <>
            <button
              onClick={handleFabricLogin}
              disabled={busy}
              style={{
                ...s.btnPrimary,
                ...(busy ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
              }}
            >
              {busy ? 'Signing in…' : 'Sign in with Fabric'}
            </button>
            {isLocalDev() && (
              <button
                onClick={handleProxyLogin}
                disabled={busy}
                style={{
                  ...s.btnPrimary,
                  background: 'transparent',
                  color: colors.accent,
                  border: `1px solid ${colors.accent}`,
                  marginTop: 12,
                  ...(busy ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
                }}
              >
                {busy ? 'Waiting for browser…' : 'Sign in via system browser'}
              </button>
            )}
          </>
        ) : (
          <div
            style={{
              background: colors.bg,
              borderRadius: 10,
              padding: '16px 20px',
              textAlign: 'left',
            }}
          >
            <p
              style={{
                margin: '0 0 4px',
                fontSize: 13,
                fontWeight: 600,
                color: colors.textSecondary,
              }}
            >
              Auth not configured
            </p>
            <p style={{ margin: 0, fontSize: 13, color: colors.textTertiary }}>
              Run{' '}
              <code
                style={{
                  background: '#e8e8ed',
                  padding: '1px 5px',
                  borderRadius: 4,
                  fontSize: 12,
                }}
              >
                rayfin up
              </code>{' '}
              to set the{' '}
              <code
                style={{
                  background: '#e8e8ed',
                  padding: '1px 5px',
                  borderRadius: 4,
                  fontSize: 12,
                }}
              >
                VITE_FABRIC_*
              </code>{' '}
              environment variables.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add Todo form
// ---------------------------------------------------------------------------
function AddTodoForm({ onCreated }: { onCreated: (todo: Todo) => void }) {
  const [title, setTitle] = useState('');
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageMime, setImageMime] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1] ?? result;
      setImageBase64(base64);
      setImageMime(file.type);
    };
    reader.readAsDataURL(file);
  };

  const clearImage = () => {
    setImageBase64(null);
    setImageMime(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const now = new Date();
      const userId = getUserId();
      const created = await client.data.Todo.create({
        Title: title.trim(),
        isCompleted: false,
        priority: 'medium',
        percentComplete: 0,
        points: 2,
        createdAt: now,
        updatedAt: now,
        user_id: userId,
      });

      if (imageBase64 && created.id) {
        await client.data.Image.create({
          todoId: created.id,
          base64: imageBase64,
          mimeType: imageMime ?? 'image/png',
          user_id: userId,
        });
      }

      setTitle('');
      clearImage();
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create todo');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {error && <div style={s.error}>{error}</div>}
      <form onSubmit={handleSubmit} style={s.formCard}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Add a new todo…"
            required
            style={s.input}
          />
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexShrink: 0,
            }}
          >
            <label style={s.fileLabel} title="Attach image">
              📎
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                style={{ display: 'none' }}
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              style={{
                ...s.btnAdd,
                ...(busy ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
              }}
            >
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
        {imageBase64 && (
          <div style={s.preview}>
            <img
              src={`data:${sanitizeMime(imageMime)};base64,${imageBase64}`}
              alt="preview"
              style={s.previewImg}
            />
            <span style={{ fontSize: 13, color: colors.textSecondary }}>
              Image attached
            </span>
            <button
              onClick={clearImage}
              style={{ ...s.smallBtn, marginLeft: 'auto' }}
              title="Remove"
              type="button"
            >
              ✕
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Todo list
// ---------------------------------------------------------------------------
function TodoPage({ onLogout }: { onLogout: () => void }) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [images, setImages] = useState<Record<string, Image>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [todoResult, imageResult] = await Promise.all([
        client.data.Todo.select([
          'id',
          'Title',
          'isCompleted',
          'priority',
          'createdAt',
          'percentComplete',
        ])
          .orderBy({ createdAt: 'desc' })
          .execute(),
        client.data.Image.select([
          'id',
          'todoId',
          'base64',
          'mimeType',
        ]).execute(),
      ]);
      setTodos(todoResult);
      const imageMap: Record<string, Image> = {};
      for (const img of imageResult) {
        imageMap[img.todoId] = img;
      }
      setImages(imageMap);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreated = (todo: Todo) => {
    setTodos((prev) => [todo, ...prev]);
    loadData();
  };

  const toggleComplete = async (todo: Todo) => {
    const updated = !todo.isCompleted;
    setTodos((prev) =>
      prev.map((t) => (t.id === todo.id ? { ...t, isCompleted: updated } : t))
    );
    try {
      if (updated) {
        // Completing a todo runs through the `completeTodo` function. In local
        // dev the Vite proxy routes this to the `func` host when it's up
        // (otherwise the deployed function); the app code is identical either
        // way. This is the frontend actually invoking a Rayfin function.
        await client.functions.completeTodo.invoke({ todoId: todo.id });
      } else {
        // Re-opening a todo is a plain data update — no function involved.
        await client.data.Todo.update(
          { id: todo.id },
          { isCompleted: false, percentComplete: 0, updatedAt: new Date() }
        );
      }
    } catch {
      // If the function path is unavailable (no local host running and the
      // function isn't deployed), fall back to a direct data update so the
      // checkbox still works during the demo.
      try {
        await client.data.Todo.update(
          { id: todo.id },
          {
            isCompleted: updated,
            percentComplete: updated ? 100 : 0,
            updatedAt: new Date(),
          }
        );
      } catch {
        setTodos((prev) =>
          prev.map((t) =>
            t.id === todo.id ? { ...t, isCompleted: !updated } : t
          )
        );
      }
    }
  };

  const deleteTodo = async (todoId: string) => {
    const prev = todos;
    setTodos((t) => t.filter((x) => x.id !== todoId));
    try {
      await client.data.Todo.delete({ id: todoId });
    } catch {
      setTodos(prev);
    }
  };

  const handleLogout = async () => {
    await client.auth.signOut();
    // In local dev, also evict the auth proxy's cached token so the next login
    // re-runs the system-browser flow instead of returning a stale session.
    if (isLocalDev()) {
      await fabricProxyLogout().catch(() => {});
    }
    onLogout();
  };

  // Minimal functions-invocation demo. Locally this call is routed by the Vite
  // proxy to a running `func` host when one is up, otherwise to the remote
  // backend — the app code is identical either way.
  const runHealthCheck = async () => {
    try {
      const result = await client.functions.healthCheck.invoke({});
      window.alert(`healthCheck → ok=${result.ok}\n${result.timestamp}`);
    } catch (err) {
      window.alert(
        `healthCheck failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const completed = todos.filter((t) => t.isCompleted).length;
  const total = todos.length;

  return (
    <div style={s.page}>
      <div style={s.container}>
        <header style={s.header}>
          <div style={s.headerLeft}>
            <span style={{ fontSize: 28 }}>✅</span>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>
              Todos
              {total > 0 && (
                <span
                  style={{
                    fontSize: 13,
                    color: colors.textTertiary,
                    fontWeight: 400,
                    marginLeft: 8,
                  }}
                >
                  {completed}/{total} done
                </span>
              )}
            </h1>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={runHealthCheck} style={s.btnGhost} type="button">
              Health check
            </button>
            <button onClick={handleLogout} style={s.btnGhost}>
              Sign Out
            </button>
          </div>
        </header>

        <AddTodoForm onCreated={handleCreated} />

        {error && <div style={s.error}>{error}</div>}

        {loading ? (
          <div
            style={{
              textAlign: 'center',
              padding: 40,
              color: colors.textTertiary,
              fontSize: 14,
            }}
          >
            Loading your todos…
          </div>
        ) : total === 0 ? (
          <div style={s.listCard}>
            <div style={s.emptyState}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>📝</div>
              <p style={{ fontSize: 16, fontWeight: 600, margin: '0 0 4px' }}>
                No todos yet
              </p>
              <p
                style={{ fontSize: 13, color: colors.textTertiary, margin: 0 }}
              >
                Add one above to get started
              </p>
            </div>
          </div>
        ) : (
          <div style={s.listCard}>
            {todos.map((todo) => {
              const img = images[todo.id];
              return (
                <div
                  key={todo.id}
                  style={s.todoItem}
                  onClick={() => toggleComplete(todo)}
                >
                  <div style={s.checkbox(todo.isCompleted)}>
                    {todo.isCompleted && '✓'}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={s.todoTitle(todo.isCompleted)}>
                      {todo.Title}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        marginTop: 2,
                      }}
                    >
                      <span style={s.priorityBadge(todo.priority)}>
                        {todo.priority}
                      </span>
                      {todo.createdAt && (
                        <span
                          style={{ fontSize: 11, color: colors.textTertiary }}
                        >
                          {formatDate(todo.createdAt)}
                        </span>
                      )}
                    </div>
                  </div>
                  {img && (
                    <img
                      src={`data:${sanitizeMime(img.mimeType ?? null)};base64,${img.base64}`}
                      alt="attachment"
                      style={{
                        width: 40,
                        height: 40,
                        objectFit: 'cover',
                        borderRadius: 8,
                        flexShrink: 0,
                      }}
                    />
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteTodo(todo.id);
                    }}
                    style={{ ...s.smallBtn, opacity: 0.4 }}
                    title="Delete"
                  >
                    🗑
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <p
          style={{
            fontSize: 12,
            color: colors.textTertiary,
            margin: '16px 0 0',
            textAlign: 'center',
            lineHeight: 1.6,
          }}
        >
          Multi-package npm workspace &bull; Entities split across{' '}
          <strong>data</strong> &amp; <strong>shared</strong> packages
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const finish = (ok: boolean) => {
      if (!cancelled) setAuthenticated(ok);
    };

    async function bootstrap(): Promise<void> {
      // Already have a live SDK session (e.g. persisted across a reload)?
      if (client.auth.getSession().isAuthenticated) return finish(true);

      // Local dev: silently restore from the dev-server auth-proxy cache so a
      // page refresh reuses the token captured during the system-browser login
      // instead of forcing a new login. This never opens a browser — on a cache
      // miss it just shows the login page (the button does the interactive login).
      if (isLocalDev()) {
        try {
          const restored = await hydrateFabricSessionFromProxyIfCached(
            (token) => createSessionFromTokenResponse(client.auth, token),
            getFabricProxyOptions()
          );
          return finish(restored !== null);
        } catch {
          return finish(false);
        }
      }

      // Production / in-WebView Fabric login path.
      const fabricOptions = getFabricOptions();
      if (fabricOptions) {
        try {
          await ensureSignedInWithFabric(client.auth, fabricOptions);
          return finish(true);
        } catch {
          return finish(false);
        }
      }

      finish(client.auth.getSession().isAuthenticated);
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogin = useCallback(() => setAuthenticated(true), []);
  const handleLogout = useCallback(() => setAuthenticated(false), []);

  if (authenticated === null) {
    return (
      <div style={{ ...s.page, ...s.loginWrapper }}>
        <div style={{ color: colors.textTertiary, fontSize: 15 }}>Loading…</div>
      </div>
    );
  }
  if (!authenticated) return <LoginPage onLogin={handleLogin} />;
  return <TodoPage onLogout={handleLogout} />;
}

createRoot(document.getElementById('root')!).render(<App />);
