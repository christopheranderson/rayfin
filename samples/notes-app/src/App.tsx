import { getFieldConstraints } from '@microsoft/rayfin-core';
import { useEffect, useState } from 'react';

import type { Note } from '../rayfin/data/Note';
import { Notebook } from '../rayfin/data/Notebook';

import { LoginForm } from './components/LoginForm';
import { NoteEditor } from './components/NoteEditor';
import { NoteList } from './components/NoteList';
import { NoteViewer } from './components/NoteViewer';
import { NotebookNav } from './components/NotebookNav';
import { useAuth } from './hooks/useAuth';
import { useNotebooks } from './hooks/useNotebooks';
import { useNotes } from './hooks/useNotes';

import { PlusIcon, DocumentIcon } from '@/components/icons';

function App() {
  const {
    user,
    loading: authLoading,
    error: authError,
    login,
    register,
    logout,
  } = useAuth();
  const {
    notebooks,
    loading: notebooksLoading,
    createNotebook,
    updateNotebook,
    deleteNotebook,
  } = useNotebooks(user?.Id || null);
  const {
    notes,
    loading: notesLoading,
    createNote,
    updateNote,
    deleteNote,
    togglePin,
  } = useNotes(user?.Id || null);

  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [selectedNotebookId, setSelectedNotebookId] = useState<
    string | null | undefined
  >(undefined);

  // Reset UI state when user changes (login/logout)
  useEffect(() => {
    setSelectedNote(null);
    setIsEditing(false);
    setIsCreating(false);
    setSelectedNotebookId(undefined);
  }, [user?.Id]);

  // Select default notebook when notebooks load (only on initial mount)
  useEffect(() => {
    if (notebooks.length === 0) {
      return;
    }

    // Only auto-select if no notebook is selected yet (undefined, not null)
    // null means user explicitly chose "All notebooks"
    if (selectedNotebookId !== undefined) {
      return;
    }

    const defaultNotebook =
      notebooks.find((nb) => nb.isDefault) || notebooks[0];

    setSelectedNotebookId(defaultNotebook.id);
  }, [notebooks]);

  const handleLogin = async (email: string, password: string) => {
    await login(email, password);
  };

  const handleRegister = async (email: string, password: string) => {
    await register(email, password);
  };

  const handleSelectNote = (note: Note) => {
    setSelectedNote(note);
    setIsEditing(false);
    setIsCreating(false);
  };

  const handleNewNote = () => {
    setSelectedNote(null);
    setIsEditing(true);
    setIsCreating(true);
  };

  const handleEditNote = () => {
    setIsEditing(true);
    setIsCreating(false);
  };

  const notebookNameConstraints = getFieldConstraints(Notebook, 'name');
  const notebookNameMax =
    notebookNameConstraints?.type === 'string'
      ? notebookNameConstraints.max
      : undefined;

  const validateNotebookName = (name: string): string | null => {
    if (!name.trim()) return 'Notebook name is required';
    if (notebookNameMax !== undefined && name.trim().length > notebookNameMax) {
      return `Notebook name must be at most ${notebookNameMax} character(s)`;
    }
    return null;
  };

  const handleCreateNotebook = async () => {
    if (!user) return;
    const defaultName =
      notebooks.length === 0 ? 'My First Notebook' : 'New Notebook';
    const name = window.prompt('Enter notebook name', defaultName);
    if (!name || !name.trim()) return;

    const validationError = validateNotebookName(name);
    if (validationError) {
      alert(validationError);
      return;
    }

    try {
      await createNotebook({
        name: name.trim(),
        description: '',
        color: '#3b82f6',
        isDefault: notebooks.length === 0,
        user_id: user.Id,
      });
    } catch (err) {
      console.error('Failed to create notebook:', err);
      alert('Failed to create notebook. Please try again.');
    }
  };

  const handleRenameNotebook = async (id: string) => {
    const notebook = notebooks.find((nb) => nb.id === id);
    const defaultName = notebook?.name || 'Notebook';
    const name = window.prompt('Enter new notebook name', defaultName);
    if (!name || !name.trim()) return;

    const validationError = validateNotebookName(name);
    if (validationError) {
      alert(validationError);
      return;
    }

    try {
      await updateNotebook(id, { name: name.trim() });
    } catch (err) {
      console.error('Failed to rename notebook:', err);
      alert('Failed to rename notebook. Please try again.');
    }
  };

  const handleDeleteNotebook = async (id: string) => {
    const notebook = notebooks.find((nb) => nb.id === id);
    const name = notebook?.name || 'this notebook';
    const confirmation = window.confirm(
      `Delete "${name}" and all notes inside it? This action cannot be undone.`
    );
    if (!confirmation) return;

    try {
      await deleteNotebook(id);
      if (selectedNotebookId === id) {
        setSelectedNotebookId(null);
        setSelectedNote(null);
        setIsEditing(false);
        setIsCreating(false);
      }
    } catch (err) {
      console.error('Failed to delete notebook:', err);
      alert('Failed to delete notebook. Please try again.');
    }
  };

  const handleMakeDefaultNotebook = async (id: string) => {
    try {
      await updateNotebook(id, { isDefault: true });
      setSelectedNotebookId(id);
    } catch (err) {
      console.error('Failed to set default notebook:', err);
      alert('Failed to set default notebook. Please try again.');
    }
  };

  const handleSaveNote = async (noteData: Partial<Note>) => {
    try {
      if (isCreating && user) {
        const defaultNotebook =
          (selectedNotebookId &&
            notebooks.find((nb) => nb.id === selectedNotebookId)) ||
          notebooks.find((nb) => nb.isDefault) ||
          notebooks[0];

        if (!defaultNotebook) {
          console.error('No notebooks available for user:', user.Id);
          alert(
            'Error: No notebooks available. Please refresh the page and try again.'
          );
          return;
        }

        console.log('Creating note with notebook:', defaultNotebook);
        const newNote = await createNote({
          ...noteData,
          user_id: user.Id,
          notebook_id: noteData.notebook_id || defaultNotebook.id,
          isPinned: noteData.isPinned || false,
          isArchived: noteData.isArchived || false,
          contentType: noteData.contentType || 'markdown',
        } as Omit<Note, 'id' | 'createdAt' | 'updatedAt'>);

        setSelectedNote(newNote);
        setIsCreating(false);
        setIsEditing(false);
      } else if (selectedNote) {
        const updatedNote = await updateNote(selectedNote.id, noteData);
        setSelectedNote(updatedNote);
        setIsEditing(false);
      }
    } catch (error) {
      console.error('Failed to save note:', error);
    }
  };

  const handleDeleteNote = async (id: string) => {
    try {
      await deleteNote(id);
      if (selectedNote?.id === id) {
        setSelectedNote(null);
        setIsEditing(false);
        setIsCreating(false);
      }
    } catch (error) {
      console.error('Failed to delete note:', error);
    }
  };

  const handleSelectNotebook = (id: string | null) => {
    setSelectedNotebookId(id);
    // Clear selected note if it doesn't belong to the selected notebook
    if (id && selectedNote && selectedNote.notebook_id !== id) {
      setSelectedNote(null);
      setIsEditing(false);
      setIsCreating(false);
    }
    if (id === null) {
      // allow selection retained even if outside; no-op
    }
  };

  const handleTogglePin = async (id: string) => {
    try {
      await togglePin(id);
      if (selectedNote?.id === id) {
        setSelectedNote({ ...selectedNote, isPinned: !selectedNote.isPinned });
      }
    } catch (error) {
      console.error('Failed to toggle pin:', error);
    }
  };

  const handleCancel = () => {
    setIsEditing(false);
    setIsCreating(false);
    if (isCreating) {
      setSelectedNote(null);
    }
  };

  // Show loading screen while checking authentication
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  // Show login form if not authenticated
  if (!user) {
    return (
      <LoginForm
        onLogin={handleLogin}
        onRegister={handleRegister}
        loading={authLoading}
        error={authError}
      />
    );
  }

  const filteredNotes =
    selectedNotebookId && selectedNotebookId !== null
      ? notes.filter((note) => note.notebook_id === selectedNotebookId)
      : notes;

  // Main application interface
  // ensure all new routes require auth
  return (
    <div className="h-screen flex flex-col bg-gray-100">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <h1 className="text-xl font-bold text-gray-900">Notes App</h1>
            <button
              onClick={handleNewNote}
              className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
            >
              <PlusIcon className="w-4 h-4" />
              <span>New Note</span>
            </button>
          </div>

          <div className="flex items-center space-x-4">
            <span className="text-sm text-gray-600">{user.Email}</span>
            <button
              onClick={logout}
              className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar: Notebooks and Notes */}
        <div className="flex h-full overflow-hidden">
          <NotebookNav
            notebooks={notebooks}
            selectedNotebookId={selectedNotebookId}
            onSelectNotebook={handleSelectNotebook}
            onCreateNotebook={handleCreateNotebook}
            onRenameNotebook={handleRenameNotebook}
            onDeleteNotebook={handleDeleteNotebook}
            onMakeDefaultNotebook={handleMakeDefaultNotebook}
          />

          <NoteList
            notes={filteredNotes}
            selectedNote={selectedNote}
            onSelectNote={handleSelectNote}
            onDeleteNote={handleDeleteNote}
            onTogglePin={handleTogglePin}
            loading={notesLoading}
            notebooks={notebooks}
            groupByNotebook={selectedNotebookId === null}
          />
        </div>

        {/* Main Panel */}
        <div className="flex-1">
          {isEditing ? (
            <NoteEditor
              note={selectedNote}
              notebooks={notebooks}
              notebooksLoading={notebooksLoading}
              selectedNotebookId={selectedNotebookId}
              onCreateNotebook={handleCreateNotebook}
              onSave={handleSaveNote}
              onCancel={handleCancel}
            />
          ) : selectedNote ? (
            <NoteViewer
              note={selectedNote}
              onEdit={handleEditNote}
              onDelete={() => handleDeleteNote(selectedNote.id)}
              onTogglePin={() => handleTogglePin(selectedNote.id)}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center bg-white">
              <div className="text-center">
                <DocumentIcon className="text-gray-300 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  No note selected
                </h3>
                <p className="text-gray-600 mb-4">
                  Select a note from the sidebar to view it, or create a new
                  one.
                </p>
                <button
                  onClick={handleNewNote}
                  className="px-4 py-2 mb-4 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                >
                  Create your first note
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
