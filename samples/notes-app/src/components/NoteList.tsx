import { useState } from 'react';

import type { Note } from '../../rayfin/data/Note';
import type { Notebook } from '../../rayfin/data/Notebook';

import {
  SearchIcon,
  BookmarkSolidIcon,
  BookmarkIcon,
  TrashIcon,
} from '@/components/icons';

interface NoteListProps {
  notes: Note[];
  selectedNote: Note | null;
  onSelectNote: (note: Note) => void;
  onDeleteNote: (id: string) => void;
  onTogglePin: (id: string) => void;
  loading: boolean;
  notebooks?: Notebook[];
  groupByNotebook?: boolean;
}

export function NoteList({
  notes,
  selectedNote,
  onSelectNote,
  onDeleteNote,
  onTogglePin,
  loading,
  notebooks = [],
  groupByNotebook = false,
}: NoteListProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredNotes = notes
    .filter(
      (note) =>
        note.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        note.content.toLowerCase().includes(searchQuery.toLowerCase())
    )
    .sort((a, b) => {
      // Pinned notes come first
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;

      // Within each group (pinned/unpinned), maintain existing order
      return 0;
    });

  const formatDate = (date: Date | undefined) => {
    if (!date) return '';
    return new Date(date).toLocaleDateString();
  };

  const truncateContent = (content: string, maxLength = 100) => {
    // Remove markdown syntax for preview
    const cleaned = content.replace(/[#*`_~]/g, '').trim();
    return cleaned.length > maxLength
      ? `${cleaned.substring(0, maxLength)}...`
      : cleaned;
  };

  if (loading) {
    return (
      <div className="w-80 bg-gray-50 border-r border-gray-200 p-4">
        <div className="animate-pulse space-y-4">
          <div className="h-10 bg-gray-200 rounded"></div>
          {[...Array(5)].map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="h-6 bg-gray-200 rounded"></div>
              <div className="h-4 bg-gray-200 rounded w-3/4"></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const renderNoteItem = (note: Note) => (
    <div
      key={note.id}
      onClick={() => onSelectNote(note)}
      className={`p-4 cursor-pointer hover:bg-gray-100 transition-colors ${
        selectedNote?.id === note.id
          ? 'bg-blue-50 border-r-2 border-blue-500'
          : ''
      }`}
    >
      <div className="flex items-start justify-between mb-2">
        <h3 className="font-medium text-gray-900 truncate flex-1">
          {note.title || 'Untitled'}
        </h3>
        <div className="flex items-center space-x-1 ml-2">
          {note.isPinned && <BookmarkSolidIcon className="text-yellow-500" />}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin(note.id);
            }}
            className="text-gray-400 hover:text-yellow-500 transition-colors"
            title={note.isPinned ? 'Unpin note' : 'Pin note'}
          >
            <BookmarkIcon />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (confirm('Are you sure you want to delete this note?')) {
                onDeleteNote(note.id);
              }
            }}
            className="text-gray-400 hover:text-red-500 transition-colors"
            title="Delete note"
          >
            <TrashIcon />
          </button>
        </div>
      </div>
      <p className="text-sm text-gray-600 mb-2">
        {truncateContent(note.content)}
      </p>
      <p className="text-xs text-gray-400">{formatDate(note.updatedAt)}</p>
    </div>
  );

  const renderGroupedNotes = () => {
    const groups: Record<string, Note[]> = {};
    filteredNotes.forEach((note) => {
      const key = note.notebook_id || 'unknown';
      if (!groups[key]) groups[key] = [];
      groups[key].push(note);
    });

    const notebookMap = new Map(notebooks.map((nb) => [nb.id, nb]));

    const sortedNotebookIds = notebooks.map((nb) => nb.id);
    const unknownIds = Object.keys(groups).filter((id) => !notebookMap.has(id));

    const orderedGroups = [...sortedNotebookIds, ...unknownIds];

    return (
      <div className="divide-y divide-gray-200">
        {orderedGroups.map((id) => {
          const notesForGroup = groups[id] || [];
          if (notesForGroup.length === 0) return null;
          const notebookName = notebookMap.get(id)?.name || 'Unknown notebook';
          return (
            <div key={id}>
              <div className="px-4 py-2 bg-gray-100 text-xs font-semibold text-gray-600 uppercase tracking-wide">
                {notebookName}
              </div>
              {notesForGroup.map((note) => renderNoteItem(note))}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="w-80 bg-gray-50 border-r border-gray-200 flex flex-col">
      {/* Search */}
      <div className="p-4 border-b border-gray-200">
        <div className="relative">
          <input
            type="text"
            placeholder="Search notes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <SearchIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
        </div>
      </div>

      {/* Notes List */}
      <div className="flex-1 overflow-y-auto">
        {filteredNotes.length === 0 ? (
          <div className="p-4 text-center text-gray-500">
            {searchQuery ? 'No notes found' : 'No notes yet'}
          </div>
        ) : (
          <>
            {groupByNotebook ? (
              renderGroupedNotes()
            ) : (
              <div className="divide-y divide-gray-200">
                {filteredNotes.map(renderNoteItem)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
