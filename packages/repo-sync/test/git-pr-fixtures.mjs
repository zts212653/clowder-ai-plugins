import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../src/process.mjs';
import { versionRepositories } from './version-fixtures.mjs';

export async function gitPrFixture(mode = 'normal') {
  const f = await versionRepositories();
  await git(f.internal, ['config', 'receive.advertisePushOptions', 'true']);
  const resultFile = join(f.root, 'push-receipt.json');
  const script = join(f.root, 'receive-pr.mjs');
  await writeFile(
    script,
    `import { writeFileSync, readFileSync, existsSync } from 'node:fs';
const opts=Array.from({length:Number(process.env.GIT_PUSH_OPTION_COUNT)},(_,i)=>process.env['GIT_PUSH_OPTION_'+i]);
let refs=''; for await(const chunk of process.stdin) refs+=chunk;
if(!opts.includes('merge_request.create')) process.exit(0);
const count=existsSync(${JSON.stringify(resultFile)}) ? JSON.parse(readFileSync(${JSON.stringify(resultFile)},'utf8')).count+1 : 1;
writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({opts,refs,count}));
if(${JSON.stringify(mode)}!=='missing') console.log('View merge request: https://codehub.example/core/-/merge_requests/501');
if(${JSON.stringify(mode)}==='ambiguous') console.log('View merge request: https://codehub.example/core/-/merge_requests/502');
console.log('private diagnostic which must not be recorded');`,
  );
  await writeFile(
    join(f.internal, 'hooks', 'post-receive'),
    `#!/bin/sh\nexec "${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"\n`,
    { mode: 0o755 },
  );
  const config = { ...f.config, internalWebUrl: 'https://codehub.example/core', pullRequests: { mode: 'git' } };
  return { ...f, config, resultFile };
}
