import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build → web/dist (el Dockerfile lo copia a /app/dist/web). El servidor de xRoster solo sirve
// /assets/* e index.html, así que los bundles deben quedar bajo assets/.
export default defineConfig({
    plugins: [react()],
    base: '/',
    build: {
        outDir: 'dist',
        assetsDir: 'assets',
        emptyOutDir: true,
        sourcemap: false
    },
    server: {
        port: 5173,
        proxy: {
            '/api': { target: 'http://127.0.0.1:3900', changeOrigin: false }
        }
    }
});
