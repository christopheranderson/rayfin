import { ChangeEvent } from 'react';

interface TodoAttachmentPickerProps {
  files: File[];
  disabled: boolean;
  onChange: (files: File[]) => void;
}

export function TodoAttachmentPicker({
  files,
  disabled,
  onChange,
}: TodoAttachmentPickerProps) {
  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = '';
    onChange([...files, ...selectedFiles]);
  };

  const handleRemove = (index: number) => {
    onChange(files.filter((_, fileIndex) => fileIndex !== index));
  };

  return (
    <div>
      <span className="block text-sm font-medium text-gray-700">
        Attachments
      </span>
      <label className="mt-1 inline-flex cursor-pointer items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus-within:ring-2 focus-within:ring-blue-500 focus-within:ring-offset-2">
        <span aria-hidden="true">📎</span>
        Add attachments
        <input
          type="file"
          multiple
          disabled={disabled}
          className="sr-only"
          onChange={handleFileChange}
        />
      </label>
      {files.length > 0 ? (
        <ul className="mt-2 space-y-1" aria-label="Selected attachments">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${file.lastModified}-${index}`}
              className="flex items-center justify-between gap-3 rounded border border-gray-200 px-3 py-2 text-sm text-gray-700"
            >
              <span className="min-w-0 truncate">{file.name}</span>
              <button
                type="button"
                title={`Remove ${file.name}`}
                aria-label={`Remove ${file.name}`}
                disabled={disabled}
                onClick={() => handleRemove(index)}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
