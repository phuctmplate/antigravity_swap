import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'path';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  root: path.resolve(__dirname, 'src/webview'),
  define: {
    __APP_VERSION__: JSON.stringify(`v${pkg.version}`),
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/webview'),
    emptyOutDir: true,
    // viteSingleFile inlines all assets into index.html
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  }
});
