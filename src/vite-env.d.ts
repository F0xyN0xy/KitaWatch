/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_PROXY_BASE_URL?: string;
  readonly VITE_ANIVEXA_BASE_URL?: string;
  readonly VITE_CONSUMET_BASE_URL?: string;
  readonly VITE_GATE_URL?: string;
  readonly VITE_HCAPTCHA_SITE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
