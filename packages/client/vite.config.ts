import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
import {defineConfig} from 'vite';

const isDesktopDev =
  process.env.VITE_BACKEND_PORT === '12077' ||
  process.env.BACKEND_PORT === '12077' ||
  process.argv.includes('22077') ||
  process.env.CROWDOS_DEV === '1';

const backendPort = process.env.VITE_BACKEND_PORT || process.env.BACKEND_PORT || (isDesktopDev ? '12077' : '12077');
const backendTarget = process.env.VITE_BACKEND_URL || `http://127.0.0.1:${backendPort}`;

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()] as any,
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      target: 'es2022',
      cssCodeSplit: true,
      chunkSizeWarningLimit: 600,
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom', 'zustand', 'socket.io-client'],
            motion: ['motion'],
            icons: ['lucide-react'],
            highlight: ['highlight.js/lib/common'],
          },
        },
      },
    },
    server: {
      port: 22077,
      host: '0.0.0.0',
      proxy: {
        '/api': {
          target: backendTarget,
          changeOrigin: true,
        },
        '/socket.io': {
          target: backendTarget,
          ws: true,
          changeOrigin: true,
          configure: (proxy) => {
            // Suppress noisy proxy errors expected during dev:
            //   ECONNRESET  — backend restarting or rejecting connections
            //   ECONNREFUSED — backend not yet up
            //   ECONNABORTED — client disconnected mid-upgrade
            const SUPPRESSED = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED']);
            const isSuppressed = (err: any) => SUPPRESSED.has(err?.code);

            // 1) Proxy-level error event (http-proxy "error")
            process.nextTick(() => {
              proxy.removeAllListeners('error');
              proxy.on('error', (err) => {
                if (!isSuppressed(err)) console.error('[vite ws proxy error]', err);
              });
            });

            // 2) Socket-level errors on raw TCP sockets during WebSocket upgrade.
            //    Vite 6.4+ adds socket.on('error') inside proxyReqWs which
            //    fires BEFORE our proxyReqWs listener. We add our own listener
            //    that re-emits nothing — the existing Vite handler will still
            //    fire, but by removing and re-adding on the *socket* we take
            //    control of the error path.
            proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
              socket.removeAllListeners('error');
              socket.on('error', (err) => {
                if (!isSuppressed(err)) console.error('[vite ws proxy socket error]', err);
              });
            });
          },
        },
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify -- file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});