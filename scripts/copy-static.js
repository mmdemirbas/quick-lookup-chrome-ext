import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
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

console.log('Copied manifest and generated placeholder icons.');