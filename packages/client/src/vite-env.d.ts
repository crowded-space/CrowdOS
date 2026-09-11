/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module 'react-dom/client' {
  export function createRoot(container: Element | DocumentFragment): any;
  export function hydrateRoot(container: Element | DocumentFragment, initialChildren: any): any;
}
