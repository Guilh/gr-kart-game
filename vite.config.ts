import { defineConfig } from 'vite';

// Absolute origin for the Open Graph tags in index.html (scrapers need absolute URLs).
// Set SITE_URL, or on Vercel it defaults to the project's production domain. Empty = relative URLs.
const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const siteUrl = (process.env.SITE_URL ?? (vercelUrl ? `https://${vercelUrl}` : '')).replace(/\/$/, '');

export default defineConfig({
  plugins: [{ name: 'site-url', transformIndexHtml: (html) => html.replaceAll('__SITE_URL__', siteUrl) }],
  server: { port: 5173, host: true },
  build: {
    target: 'es2022',
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
