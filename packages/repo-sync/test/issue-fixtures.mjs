import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function issuePlatform(f) {
  const data = join(f.root, 'platform.json');
  const script = join(f.root, 'platform.mjs');
  await writeFile(data, JSON.stringify({ creates: 0, links: 0, updates: 0, items: {}, loseCreate: false }));
  await writeFile(
    script,
    `import {readFile,writeFile} from 'node:fs/promises';
let input='';for await(const c of process.stdin)input+=c;
const r=JSON.parse(input),p=process.argv[2],s=JSON.parse(await readFile(p,'utf8'));
let issue=s.items[r.key]??null;
if(r.operation==='create'){s.creates++;issue={sourceId:r.sourceId,key:r.key,internalId:'318',url:r.repository+'/issues/318',state:'open',links:[]};s.items[r.key]=issue;}
if(r.operation==='link'){s.links++;if(!issue.links.some(x=>x.url===r.pr.url))issue.links.push(r.pr);}
if(r.operation==='update'){s.updates++;issue.state=r.desiredState;}
await writeFile(p,JSON.stringify(s));
if((r.operation==='find'&&s.failFind)||(r.operation==='create'&&s.loseCreate)||(r.operation==='update'&&s.loseUpdate)){process.exitCode=1;}else process.stdout.write(JSON.stringify({schema:1,issue}));`,
  );
  return {
    config: { mode: 'command', command: process.execPath, args: [script, data] },
    read: async () => JSON.parse(await readFile(data, 'utf8')),
    edit: async (values) => {
      const s = JSON.parse(await readFile(data, 'utf8'));
      await writeFile(data, JSON.stringify({ ...s, ...values }));
    },
  };
}
