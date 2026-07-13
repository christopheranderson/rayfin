/// <reference types="vite/client" />

// The shadcn/ui components import individual lucide icons via deep ESM paths
// (e.g. `lucide-react/dist/esm/icons/chevron-down`) for tree-shaking. Those
// subpaths ship JS but no per-file type declarations, so declare them here so
// the strict build can resolve them.
declare module 'lucide-react/dist/esm/icons/*' {
  import type { ComponentType } from 'react';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const icon: ComponentType<any>;
  export default icon;
}
