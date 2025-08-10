import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        rollupOptions: {
            input: {
                background: resolve(__dirname, 'src/background/index.ts'),
                content: resolve(__dirname, 'src/content/index.ts'),
                options: resolve(__dirname, 'src/options/index.html'),
                action: resolve(__dirname, 'src/action/index.html')
            },
            output: {
                entryFileNames: (chunkInfo) => {
                    // stable names for MV3 manifest
                    const name = chunkInfo.name?.split('/')?.pop();
                    if (name === 'index' && /background/.test(chunkInfo.facadeModuleId || '')) return 'background.js';
                    if (name === 'index' && /content/.test(chunkInfo.facadeModuleId || '')) return 'content.js';
                    return '[name].js';
                },
                chunkFileNames: 'chunks/[name].js',
                assetFileNames: (assetInfo) => {
                    if (/\.css$/.test(assetInfo.name || '')) return '[name][extname]';
                    return 'assets/[name][extname]';
                }
            }
        }
    }
});