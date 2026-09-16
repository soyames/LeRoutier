import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// Never log matched text or raw process output. The reference stays outside the repo.
try {
  const reference=process.env.SECRET_REFERENCE_FILE || path.join(os.homedir(),'Downloads','leroutier-db.txt');
  if(path.resolve(reference).startsWith(process.cwd()+path.sep)) throw new Error();
  const raw=fs.readFileSync(reference,'utf8'),values=new Set();
  for(const match of raw.matchAll(/postgres(?:ql)?:\/\/[^\s'"`<>]+/gi)) {
    const url=new URL(match[0]);
    for(const value of [match[0],url.toString(),url.username,url.password,url.hostname,decodeURIComponent(url.username),decodeURIComponent(url.password)]) if(value)values.add(value);
  }
  for(const line of raw.split(/\r?\n/)) {
    const pair=line.match(/^\s*(?:password|username|host|hostname|api[_ -]?key|token)\s*[:=]\s*['"]?(.+?)['"]?\s*$/i);
    if(pair?.[1]) values.add(pair[1]);
  }
  if(!values.size) throw new Error();
  const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
  let failures=0,checked=0;
  function scan(text,isBundle=false) {
    checked++;
    if([...values].some(value=>text.includes(value))) failures++;
    if(isBundle && (/postgres(?:ql)?:\/\//i.test(text) || /DATABASE_URL/.test(text))) failures++;
    if(/VITE_[A-Z_]*(?:DATABASE|DB_PASSWORD|NEON|SECRET)[A-Z_]*\s*=\s*[^\s]/.test(text)) failures++;
    if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) failures++;
    if(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(text)) failures++;
  }
  for(const file of files) {
    if(!fs.existsSync(file)) continue;
    if(/(?:^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.env.example')) {failures++;continue;}
    scan(fs.readFileSync(file,'utf8'));
  }
  // Derived from the apps directory rather than listed, so a new app — or the
  // canonical unified PWA — cannot be left unscanned by omission.
  const apps=fs.existsSync('apps')?fs.readdirSync('apps',{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name):[];
  for(const app of apps) {
    const dir=`apps/${app}/dist`;
    if(fs.existsSync(dir)) for(const entry of fs.readdirSync(dir,{recursive:true})) {
      const file=path.join(dir,entry);if(fs.statSync(file).isFile())scan(fs.readFileSync(file,'utf8'),true);
    }
  }
  scan(execFileSync('git',['diff','HEAD','--no-ext-diff'],{encoding:'utf8',maxBuffer:30_000_000}));
  scan(execFileSync('git',['log','--all','-p','--no-ext-diff'],{encoding:'utf8',maxBuffer:60_000_000}));
  for(const file of ['.env.local','services/api/.env.local',...apps.map(app=>`apps/${app}/.env.local`)]) {
    execFileSync('git',['check-ignore','--quiet',file]);
  }
  // The committed local-database file must stay local-only: if it ever grows a
  // remote host, the isolation this repository promises is gone.
  if(fs.existsSync('docker/postgres.env')) {
    const text=fs.readFileSync('docker/postgres.env','utf8');
    checked++;
    for(const match of text.matchAll(/postgres(?:ql)?:\/\/[^\s'"`]+/gi)) {
      if(!['localhost','127.0.0.1','::1'].includes(new URL(match[0]).hostname)) failures++;
    }
  }
  if(failures) {console.error(`Secret scan failed: ${failures} unsafe content checks. Matched values withheld.`);process.exitCode=1;}
  else console.log(`Secret scan passed: ${checked} source, diff, history and bundle checks. No reference secrets found.`);
} catch {console.error('Secret scan could not complete safely. No reference values displayed.');process.exitCode=1;}
