import { copyFileSync, mkdirSync, writeFileSync, cpSync } from 'fs';
import { build } from 'esbuild';

// Create function output directories
mkdirSync('.vercel/output/functions/api/xoro-proxy.func', { recursive: true });
mkdirSync('.vercel/output/functions/api/dropbox-proxy.func', { recursive: true });
mkdirSync('.vercel/output/functions/api/parse-excel.func', { recursive: true });
mkdirSync('.vercel/output/functions/api/ats-sync.func', { recursive: true });

// Copy simple functions (no npm deps)
copyFileSync('api/xoro-proxy.js', '.vercel/output/functions/api/xoro-proxy.func/index.js');
copyFileSync('api/dropbox-proxy.js', '.vercel/output/functions/api/dropbox-proxy.func/index.js');
copyFileSync('api/ats-sync.js', '.vercel/output/functions/api/ats-sync.func/index.js');

// Bundle parse-excel with its npm dependencies (formidable, xlsx) into a single file
await build({
  entryPoints: ['api/parse-excel.js'],
  outfile: '.vercel/output/functions/api/parse-excel.func/index.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['fs', 'path', 'os', 'stream', 'crypto', 'events', 'buffer', 'util', 'http', 'https', 'net', 'tls', 'zlib'],
});

// Write Vercel function config for each
const vcConfig = JSON.stringify({ runtime: 'nodejs20.x', handler: 'index.js', launcherType: 'Nodejs', shouldAddHelpers: true });
writeFileSync('.vercel/output/functions/api/xoro-proxy.func/.vc-config.json', vcConfig);
writeFileSync('.vercel/output/functions/api/dropbox-proxy.func/.vc-config.json', vcConfig);
writeFileSync('.vercel/output/functions/api/parse-excel.func/.vc-config.json', vcConfig);
writeFileSync('.vercel/output/functions/api/ats-sync.func/.vc-config.json', JSON.stringify({ ...JSON.parse(vcConfig), maxDuration: 800 }));

// Copy static build output
cpSync('dist', '.vercel/output/static', { recursive: true });

// Write config.json — routes /api/* to functions, everything else to SPA
const config = {
  version: 3,
  routes: [
    { src: '/api/xoro-proxy(.*)', dest: '/api/xoro-proxy$1' },
    { src: '/api/dropbox-proxy(.*)', dest: '/api/dropbox-proxy$1' },
    { src: '/api/parse-excel(.*)', dest: '/api/parse-excel$1' },
    { src: '/api/ats-sync(.*)', dest: '/api/ats-sync$1' },
    { src: '/assets/(.*)', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
    { handle: 'filesystem' },
    { src: '/(.*)', dest: '/index.html' }
  ]
};
writeFileSync('.vercel/output/config.json', JSON.stringify(config, null, 2));

console.log('✓ Vercel output prepared — static + API functions');
