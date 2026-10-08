import type { Note } from '../../rayfin/data/Note';

import { BookmarkIcon, EditIcon, TrashIcon } from '@/components/icons';

interface NoteViewerProps {
  note: Note;
  onEdit: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
}

export function NoteViewer({
  note,
  onEdit,
  onDelete,
  onTogglePin,
}: NoteViewerProps) {
  const formatDate = (date: Date | undefined) => {
    if (!date) return '';
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const renderContent = (content: string, contentType: string) => {
    if (contentType === 'markdown') {
      // Simple markdown rendering for basic formatting
      return content.split('\n').map((line, index) => {
        // Headers
        if (line.startsWith('### ')) {
          return (
            <h3 key={index} className="text-lg font-semibold mt-4 mb-2">
              {line.substring(4)}
            </h3>
          );
        }
        if (line.startsWith('## ')) {
          return (
            <h2 key={index} className="text-xl font-semibold mt-4 mb-2">
              {line.substring(3)}
            </h2>
          );
        }
        if (line.startsWith('# ')) {
          return (
            <h1 key={index} className="text-2xl font-bold mt-4 mb-3">
              {line.substring(2)}
            </h1>
          );
        }

        // Lists
        if (line.startsWith('- ')) {
          return (
            <ul key={index} className="list-disc list-inside mb-2">
              <li>{line.substring(2)}</li>
            </ul>
          );
        }

        // Checkboxes
        if (line.startsWith('- [ ] ')) {
          return (
            <div key={index} className="flex items-center mb-1">
              <input type="checkbox" className="mr-2" />
              <span>{line.substring(6)}</span>
            </div>
          );
        }
        if (line.startsWith('- [x] ')) {
          return (
            <div key={index} className="flex items-center mb-1">
              <input type="checkbox" checked className="mr-2" />
              <span className="line-through text-gray-500">
                {line.substring(6)}
              </span>
            </div>
          );
        }

        // Empty lines
        if (line.trim() === '') {
          return <br key={index} />;
        }

        // Regular paragraphs with inline formatting
        let formattedLine = line;
        // Bold
        formattedLine = formattedLine.replace(
          /\*\*(.*?)\*\*/g,
          '<strong>$1</strong>'
        );
        // Italic
        formattedLine = formattedLine.replace(/\*(.*?)\*/g, '<em>$1</em>');
        // Code
        formattedLine = formattedLine.replace(
          /`(.*?)`/g,
          '<code class="bg-gray-100 px-1 py-0.5 rounded text-sm">$1</code>'
        );

        return (
          <p
            key={index}
            className="mb-2"
            dangerouslySetInnerHTML={{ __html: formattedLine }}
          />
        );
      });
    }

    // Plain text
    return <pre className="whitespace-pre-wrap font-sans">{content}</pre>;
  };

  return (
    <div className="flex-1 bg-white">
      {/* Header */}
      <div className="border-b border-gray-200 p-6">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center space-x-2 mb-2">
              <h1 className="text-2xl font-bold text-gray-900">{note.title}</h1>
              {note.isPinned && (
                <svg
                  className="w-5 h-5 text-yellow-500"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path d="M5 4a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 18V4z" />
                </svg>
              )}
            </div>
            <div className="text-sm text-gray-500 space-y-1">
              <p>Created: {formatDate(note.createdAt)}</p>
              {note.updatedAt && <p>Updated: {formatDate(note.updatedAt)}</p>}
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={onTogglePin}
              className={`p-2 rounded-md transition-colors ${
                note.isPinned
                  ? 'text-yellow-600 bg-yellow-50 hover:bg-yellow-100'
                  : 'text-gray-400 hover:text-yellow-600 hover:bg-yellow-50'
              }`}
              title={note.isPinned ? 'Unpin note' : 'Pin note'}
            >
              <BookmarkIcon className="w-5 h-5" />
            </button>

            <button
              onClick={onEdit}
              className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
              title="Edit note"
            >
              <EditIcon className="w-5 h-5" />
            </button>

            <button
              onClick={() => {
                if (confirm('Are you sure you want to delete this note?')) {
                  onDelete();
                }
              }}
              className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
              title="Delete note"
            >
              <TrashIcon className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="p-6">
        <div className="prose max-w-none">
          {renderContent(note.content, note.contentType)}
        </div>
      </div>
    </div>
  );
}
