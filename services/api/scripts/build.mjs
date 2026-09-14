import { build } from 'esbuild';
await build({entryPoints:['api/index.js'],outfile:'dist/index.js',bundle:true,platform:'node',target:'node22',format:'esm',packages:'external'});
console.log('API build passed.');
