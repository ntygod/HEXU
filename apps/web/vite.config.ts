import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
const env = loadEnv('development', process.cwd(), 'HEXU_');
const target = `http://127.0.0.1:${env.HEXU_PORT ?? 4310}`;
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target }, '/health': { target } },
  },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
