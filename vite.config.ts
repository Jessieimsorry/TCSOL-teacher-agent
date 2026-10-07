import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { host: '127.0.0.1', port: 8791, proxy: { '/api': 'http://127.0.0.1:8790' } }, build: { outDir: 'dist' } });
