import {readdir,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import assert from 'node:assert/strict';

async function files(path){const out=[];for(const entry of await readdir(path,{withFileTypes:true})){if(['node_modules','dist','generated','screenshots'].includes(entry.name))continue;const full=join(path,entry.name);if(entry.isDirectory())out.push(...await files(full));else out.push(full);}return out;}
const source=[...(await files('server')),...(await files('ui')),...(await files('extensions').catch(()=>[])),...(await files('scripts'))].filter(p=>/\.(mjs|js)$/.test(p));
for(const path of source){const result=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});if(result.status!==0)throw new Error(`${path}\n${result.stderr}`);}
const docker=await readFile('Dockerfile','utf8');assert.match(docker,/USER node/);assert.match(docker,/CMD \["npm", "start"\]/);
const manifest=JSON.parse(await readFile('package.json','utf8'));assert.equal(manifest.scripts.start,'node server/index.js');
const font=await readFile('server/assets/fonts/NotoSansSC.ttf');assert.equal(font.subarray(0,4).toString('hex'),'00010000');
assert.match(await readFile('server/assets/fonts/OFL.txt','utf8'),/SIL OPEN FONT LICENSE/);
assert.match(await readFile('ui/index.html','utf8'),/runtime-config\.js/);
const bash=spawnSync('bash',['-n','deploy/deploy.sh'],{encoding:'utf8'});assert.equal(bash.status,0,bash.stderr);
console.log(`Validated ${source.length} JavaScript sources, runtime entry, font/license and deployment script syntax.`);
