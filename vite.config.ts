import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// The AvNav webapp is a thin LAUNCHER, not an embedded React panel: AvNav is a
// whole foreign SPA served at its own origin root on its own port, so we open
// it in a new tab rather than iframing it (which would break under an https
// admin / X-Frame-Options). A plain Vite build of a small HTML+TS entry into
// public/ keeps packaging/versioning consistent with the other plugins.
export default defineConfig({
  base: '/signalk-avnav/',
  root: resolve(here, 'webapp'),
  build: {
    outDir: resolve(here, 'public'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    modulePreload: false
  },
  // Local dev: `npm run dev` serves the launcher; the /plugins/* fetch is
  // proxied to a running SignalK server pointed at via SIGNALK_DEV_URL.
  server: {
    port: 5173,
    proxy: {
      '/plugins': process.env.SIGNALK_DEV_URL || 'http://127.0.0.1:3000'
    }
  }
})
