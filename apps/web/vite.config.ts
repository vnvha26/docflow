import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxy = { '/api': { target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:3000', changeOrigin: true } };
const require = createRequire(import.meta.url);
const DOCX_SCRIPTS = 'virtual:docflow-docx-scripts';

function docxScripts(): Plugin {
  const files = {
    jszip: join(dirname(require.resolve('jszip/package.json')), 'dist', 'jszip.min.js'),
    docxPreview: join(dirname(require.resolve('docx-preview')), 'docx-preview.min.js'),
  };
  return {
    name: 'docflow-docx-scripts',
    resolveId: (id) => (id === DOCX_SCRIPTS ? `\0${DOCX_SCRIPTS}` : null),
    load(id) {
      if (id !== `\0${DOCX_SCRIPTS}`) return null;
      return Object.entries(files).map(([name, file]) => {
        this.addWatchFile(file);
        return `export const ${name} = ${JSON.stringify(readFileSync(file, 'utf8'))};`;
      }).join('\n');
    },
  };
}

export default defineConfig({
  plugins: [react(), docxScripts()],
  server: { port: 5173, strictPort: true, proxy: apiProxy },
  preview: { port: 5173, strictPort: true, proxy: apiProxy },
});
