import { mkdirSync, writeFileSync, copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const dist = resolve(root, 'dist');
const iconsDir = resolve(dist, 'icons');

if (!existsSync(iconsDir)) mkdirSync(iconsDir, { recursive: true });

// Tiny 1×1 transparent PNG
const blankPngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
const b = Buffer.from(blankPngBase64, 'base64');
writeFileSync(resolve(iconsDir, '16.png'), b);
writeFileSync(resolve(iconsDir, '48.png'), b);
writeFileSync(resolve(iconsDir, '128.png'), b);

// Copy manifest.json as-is
copyFileSync(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'));

// Vite builds HTML entries into paths like dist/src/options/index.html.
// We move them to the dist root to match the manifest.
const moveHtml = (from, to) => {
    const fromPath = resolve(dist, from);
    const toPath = resolve(dist, to);
    if (existsSync(fromPath)) {
        renameSync(fromPath, toPath);
        console.log(`Moved ${from} to ${to}`);
    } else {
        console.warn(`Warning: ${fromPath} not found, skipping move.`);
    }
};

moveHtml('src/options/index.html', 'options.html');
moveHtml('src/action/index.html', 'action.html');

// Clean up the empty 'dist/src' directory if it exists
const distSrc = resolve(dist, 'src');
if (existsSync(distSrc)) {
    try {
        rmSync(distSrc, { recursive: true, force: true });
        console.log('Cleaned up empty dist/src directory.');
    } catch (e) {
        console.error('Failed to remove dist/src directory:', e);
    }
}

console.log('Copied manifest, moved HTML files, and generated placeholder icons.');