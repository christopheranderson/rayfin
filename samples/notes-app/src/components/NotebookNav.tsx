import type { Notebook } from '../../rayfin/data/Notebook';

import {
  PlusIcon,
  StarIcon,
  EditIcon,
  TrashIcon,
  ChevronDownIcon,
} from '@/components/icons';

interface NotebookNavProps {
  notebooks: Notebook[];
  selectedNotebookId: string | null | undefined;
  onSelectNotebook: (notebookId: string | null) => void;
  onCreateNotebook: () => Promise<void> | void;
  onRenameNotebook: (id: string) => Promise<void> | void;
  onDeleteNotebook: (id: string) => Promise<void> | void;
  onMakeDefaultNotebook?: (id: string) => Promise<void> | void;
}

export function NotebookNav({
  notebooks,
  selectedNotebookId,
  onSelectNotebook,
  onCreateNotebook,
  onRenameNotebook,
  onDeleteNotebook,
  onMakeDefaultNotebook,
}: NotebookNavProps) {
  const handleCreate = async () => {
    await onCreateNotebook();
  };

  return (
    <div className="w-64 bg-white border-r border-gray-200 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <h2 className="text-sm font-semibold text-gray-800">Notebooks</h2>
        <button
          onClick={handleCreate}
          className="p-1 text-gray-500 hover:text-blue-600 transition-colors"
          title="Create notebook"
        >
          <PlusIcon />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <button
          onClick={() => onSelectNotebook(null)}
          className={`w-full text-left px-4 py-2 text-sm flex items-center justify-between hover:bg-blue-50 transition-colors ${
            selectedNotebookId === null
              ? 'bg-blue-50 text-blue-700 font-medium'
              : 'text-gray-700'
          }`}
        >
          <span>All notebooks</span>
          {selectedNotebookId === null && <ChevronDownIcon />}
        </button>

        <div className="mt-1">
          {notebooks.map((notebook) => (
            <div
              key={notebook.id}
              className={`group flex items-center justify-between px-4 py-2 text-sm cursor-pointer hover:bg-blue-50 transition-colors ${
                selectedNotebookId === notebook.id
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-gray-700'
              }`}
              onClick={() => onSelectNotebook(notebook.id)}
            >
              <div className="flex flex-col">
                <span className="truncate">{notebook.name}</span>
                {notebook.isDefault && (
                  <span className="text-xs text-blue-400">Default</span>
                )}
              </div>
              <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {!notebook.isDefault && onMakeDefaultNotebook && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void onMakeDefaultNotebook(notebook.id);
                    }}
                    className="p-1 text-gray-400 hover:text-blue-500"
                    title="Make default notebook"
                  >
                    <StarIcon />
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void onRenameNotebook(notebook.id);
                  }}
                  className="p-1 text-gray-400 hover:text-blue-500"
                  title="Rename notebook"
                >
                  <EditIcon />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void onDeleteNotebook(notebook.id);
                  }}
                  className="p-1 text-gray-400 hover:text-red-500"
                  title="Delete notebook"
                >
                  <TrashIcon />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
