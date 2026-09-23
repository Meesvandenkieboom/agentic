import { join, resolve } from 'node:path';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import autoprefixer from 'autoprefixer';
import { mockApi } from './api';
import { initialSessionId } from './fixtures';
import { websocket, type SocketState } from './socket';

// Build the production React entrypoint and stylesheet against an isolated mock backend.
const root = import.meta.dir;
const repo = resolve(root, '../..');
const build = await Bun.build({
  entrypoints: [join(repo, 'client/index.tsx')], target: 'browser', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const cssPath = join(repo, 'client/globals.css');
const css = await postcss([tailwindcss(), autoprefixer]).process(await Bun.file(cssPath).text(), { from: cssPath });
const bootstrap = `<script>if (!sessionStorage.getItem('agentic-preview-initialized')) {sessionStorage.setItem('agentic-tab-active-session', '${initialSessionId}'); sessionStorage.setItem('agentic-preview-initialized', 'true'); localStorage.setItem('agentic-model', 'codex-6-sol');}</script>`;
const template = (await Bun.file(join(repo, 'client/index.html')).text())
  .replace('<title>Agentic</title>', '<title>Agentic · UI preview</title>')
  .replace('<script type="module"', `${bootstrap}<script type="module"`);
const headers = { 'Cache-Control': 'no-store' };
const server = Bun.serve<SocketState>({
  port: 3002, hostname: '0.0.0.0',
  async fetch(request, server) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/ws') {
      if (server.upgrade(request, { data: { timers: new Set() } })) return;
      return new Response('WebSocket upgrade required', { status: 426 });
    }
    if (path.startsWith('/api/')) return mockApi(request);
    if (path === '/') {
      return new Response(template, { headers: { ...headers, 'Content-Type': 'text/html' } });
    }
    if (path === '/client/index.tsx') return new Response(build.outputs[0], { headers: { ...headers, 'Content-Type': 'text/javascript' } });
    if (path === '/dist/globals.css') return new Response(css.css, { headers: { ...headers, 'Content-Type': 'text/css' } });
    if (path === '/client/agentic-icon.svg') return new Response(Bun.file(join(repo, 'client/agentic-icon.svg')));
    if (path.startsWith('/katex/')) {
      const base = join(repo, 'node_modules/katex/dist');
      const file = resolve(base, path.slice('/katex/'.length));
      if (file.startsWith(`${base}/`)) return new Response(Bun.file(file));
    }
    return new Response('Not found', { status: 404 });
  },
  websocket,
});
console.log(`Agentic real UI + mock data: http://localhost:${server.port}`);
