import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
import {defineConfig} from 'vite';

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
          },
        },
      },
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3001',
          changeOrigin: true,
        },
        '/socket.io': {
          target: 'http://127.0.0.1:3001',
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