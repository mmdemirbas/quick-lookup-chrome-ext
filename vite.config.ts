import {defineConfig} from 'vite';
import {resolve} from 'node:path';

export default defineConfig({
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        cssCodeSplit: false, // <— ensure styles (if any) aren’t split out
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
                // Disable creation of shared chunks so content.js is self‑contained
                manualChunks: undefined
            }
        }
    }
});