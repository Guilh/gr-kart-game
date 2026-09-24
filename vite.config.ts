import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';

// Absolute origin for the Open Graph tags in index.html (scrapers need absolute URLs).
// Set SITE_URL, or on Vercel it defaults to the project's production domain. Empty = relative URLs.
const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const siteUrl = (process.env.SITE_URL ?? (vercelUrl ? `https://${vercelUrl}` : '')).replace(/\/$/, '');

export default defineConfig({
  plugins: [
    { name: 'site-url', transformIndexHtml: (html) => html.replaceAll('__SITE_URL__', siteUrl) },
    {
      // build.license only sees JS modules; the Fontsource woff/woff2 files are shipped too (SIL OFL requires the notice)
      name: 'font-licenses',
      apply: 'build',
      writeBundle(opts) {
        const fonts = ['@fontsource/titillium-web', '@fontsource/chakra-petch'];
        const text = fonts.map((f) => `\n## ${f} (OFL-1.1)\n\n${readFileSync(`node_modules/${f}/LICENSE`, 'utf8').trim()}\n`).join('');
        appendFileSync(join(opts.dir!, 'third-party-licenses.md'), text);
      },
    },
  ],
  server: { port: 5173, host: true },
  build: {
    target: 'es2022',
    // minification strips license comments; ship the bundled dependencies' licenses (three.js MIT, fonts OFL) as a file
    license: { fileName: 'third-party-licenses.md' },
    rolldownOptions: {
      output: {
        // three.js out of the app chunk so it caches across deploys (Rolldown's replacement for manualChunks).
        // three ships as core + WebGL renderer modules; one chunk each keeps both under Vite's 500 kB warning.
        codeSplitting: {
          groups: [
            { name: 'three-core', test: /[\\/]node_modules[\\/]three[\\/]build[\\/]three\.core\.js$/, priority: 2 },
            { name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
});
