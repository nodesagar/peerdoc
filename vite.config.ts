/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

const PUBLIC_PRECACHE = ['manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

const isNonLatinFont = (f: string) => f.endsWith('.woff2') && !/-latin-/.test(f);

/** Emits /sw.js with every built file precached; version = hash of the build output. */
function serviceWorker(): Plugin {
  return {
    name: 'editordoc-service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map')).sort();
      const template = readFileSync(path.resolve(__dirname, 'src/sw.js'), 'utf8');
      const hash = createHash('sha256').update(template);
      for (const f of files) {
        const out = bundle[f];
        hash.update(f).update(out.type === 'chunk' ? out.code : out.source);
      }
      // Non-Latin font subsets (~800 KB) are cached on first use instead of up front.
      const precache = ['./', ...PUBLIC_PRECACHE, ...files.filter((f) => f !== 'index.html' && !isNonLatinFont(f))];
      const source = template
        .replace('__VERSION__', hash.digest('hex').slice(0, 12))
        .replace('__PRECACHE__', JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    serviceWorker(),
  ],
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // Adds the 'error' listener trystero 0.20 forgets on negotiating peers (see file)
      { find: /^@thaunknown\/simple-peer$/, replacement: path.resolve(__dirname, 'src/lib/crdt/safeSimplePeer.ts') },
    ],
  },
  test: {
    globals: true,
    environment: 'happy-dom',
  },
  server: {
    port: 3000,
    host: true,
  },
});
