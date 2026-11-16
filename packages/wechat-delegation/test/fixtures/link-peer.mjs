// Synthetic protocol peer, never a WeChat account or network adapter.
import { createInterface } from 'node:readline';
const mode=process.argv[2];
for await (const line of createInterface({input:process.stdin})) {
  const {id,method,params}=JSON.parse(line);
  let result;
  if(method==='hello') result={product:'clowder-wechat-link',version:'0.1.0',pid:process.pid,protocolVersion:1,upstreamCommit:'ed976d78c1e1cc2a49ad17d1e2c0da023bbb5c8e',capabilities:['stdio-v1','text-protocol-subset','account-login-v1','durable-text-send-v1','durable-text-sync-v1','current-directory-v1','explicit-session-resume-v1'],nativeApiAvailable:true,accountServiceReady:false};
  if(method==='status') result={serverId:'synthetic-store',accountGeneration:1,accountIdentity:'synthetic-user',credentialsAvailable:true,authenticated:true,connection:'online',egress:[]};
  if(method==='text.send') {
    if(mode==='lost-ack') continue;
    result={id:params.operationId,...params.lease,state:'accepted',createdAt:1,clientMessageId:1,serverId:'1234'};
  }
  if(method==='login.operation') result={operation:{id:params.operationId,generation:1,accountGeneration:1,phase:'pending',accountIdentity:null,startedAtMs:1,updatedAtMs:2,authenticationMayHaveOccurred:false},qr:null};
  if(mode==='nested-secret' && method==='login.operation') result.operation.sessionKey='SENTINEL_SESSION_SECRET';
  if(mode==='wrong-pid' && method==='hello') result.pid++;
  if(mode==='exit-on-status' && method==='status') process.exit(1);
  process.stdout.write(`${JSON.stringify({id,result})}\n`);
}
