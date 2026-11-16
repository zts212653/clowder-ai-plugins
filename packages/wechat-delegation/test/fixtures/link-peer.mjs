// Synthetic protocol peer, never a WeChat account or network adapter.
import { createInterface } from 'node:readline';
const mode=process.argv[2], sends=new Map(), auth=new Map();
let online=!['auth','auth-secret','stored','lan','lan-lost'].includes(mode),credentials=online||mode==='stored',generation=credentials?1:0;
const qr={pngBase64:'iVBORw0KGgo=',expiresAt:Math.floor(Date.now()/1000)+300};
for await (const line of createInterface({input:process.stdin})) {
  const {id,method,params}=JSON.parse(line);
  let result;
  if(method==='hello')result={product:'clowder-wechat-link',version:'0.1.0',pid:process.pid,protocolVersion:1,upstreamCommit:'ed976d78c1e1cc2a49ad17d1e2c0da023bbb5c8e',capabilities:['stdio-v1','text-protocol-subset','account-login-v1','durable-text-send-v1','durable-text-sync-v1','current-directory-v1','explicit-session-resume-v1','canonical-message-lookup-v1','stable-text-stream-v1','explicit-login-lan-v1'],nativeApiAvailable:true,accountServiceReady:false};
  if(method==='status')result={serverId:'synthetic-store',accountGeneration:generation,accountIdentity:credentials?'synthetic-user':null,credentialsAvailable:credentials,authenticated:online,connection:online?'online':credentials?'stored':'offline',stream:credentials?{sourceRef:'stream-one',resetEpoch:0,eventCursor:'0',caughtUp:online}:null,egress:[]};
  if(method==='text.send') {
    if(mode==='lost-ack')continue;
    const receipt={id:params.operationId,...params.lease,state:'accepted',createdAt:1,clientMessageId:sends.size+1,serverId:String(1234+sends.size)};
    sends.set(params.operationId,{receipt,text:params.text});result=receipt;
  }
  if(method==='send.receipt'||method==='send.cancel')result=sends.get(params.operationId)?.receipt;
  if(method==='message.by_server'){
    const entry=[...sends.values()].find(entry=>entry.receipt.serverId===params.serverId);
    if(entry)result={id:`1:${params.serverId}`,accountGeneration:1,accountIdentity:'synthetic-user',threadId:entry.receipt.destination,senderId:null,direction:'outgoing',serverId:params.serverId,messageType:1,body:entry.text,createdAt:1};
  }
  if(method==='conversation.pause')result={paused:true};
  if(method==='login.start'){
    const operation={id:params.operationId,generation:1,accountGeneration:generation,phase:'pending',accountIdentity:null,startedAtMs:1,updatedAtMs:2,authenticationMayHaveOccurred:false,lanApprovalRequested:false,lanDeadlineAtMs:null};
    auth.set(params.operationId,operation);result={operation,qr};
    if(mode==='auth-secret')operation.sessionKey='SENTINEL_SESSION_SECRET';
  }
  if(method==='login.poll'){
    const operation=auth.get(params.operationId);
    if(operation&&mode.startsWith('lan')&&operation.phase==='pending'){operation.phase='lan_awaiting_consent';}
    else if(operation&&['pending','lan_verifying'].includes(operation.phase)){operation.phase='succeeded';operation.accountIdentity='synthetic-user';operation.authenticationMayHaveOccurred=true;operation.updatedAtMs++;online=true;credentials=true;generation++;}
    if(operation)result={operation,qr:null};
  }
  if(method==='login.cancel'){
    const operation=auth.get(params.operationId);if(operation&&['pending','scanned','lan_awaiting_consent','lan_verifying'].includes(operation.phase))operation.phase='cancelled';if(operation)result={operation,qr:null};
  }
  if(method==='login.allow_lan'){
    const operation=auth.get(params.operationId);
    if(operation&&!operation.lanApprovalRequested){operation.lanApprovalRequested=true;operation.lanDeadlineAtMs=Date.now()+120000;operation.phase='lan_verifying';}
    result=operation?{operation,qr:null}:undefined;
    if(mode==='lan-lost')continue;
  }
  if(method==='login.operation'){
    const operation=auth.get(params.operationId)??{id:params.operationId,generation:1,accountGeneration:1,phase:'pending',accountIdentity:null,startedAtMs:1,updatedAtMs:2,authenticationMayHaveOccurred:false,lanApprovalRequested:false,lanDeadlineAtMs:null};
    result={operation,qr:auth.has(params.operationId)&&operation.phase==='pending'?qr:null};
  }
  if(method==='session.resume'){
    result={id:params.operationId,sourceGeneration:params.accountGeneration,accountGeneration:params.accountGeneration+1,accountIdentity:params.accountIdentity,phase:'succeeded',authenticationMayHaveOccurred:true,startedAtMs:1,updatedAtMs:2};
    auth.set(params.operationId,result);generation=result.accountGeneration;online=true;credentials=true;
  }
  if(method==='session.operation')result=auth.get(params.operationId);
  if(mode==='nested-secret'&&method==='login.operation')result.operation.sessionKey='SENTINEL_SESSION_SECRET';
  if(mode==='wrong-pid'&&method==='hello')result.pid++;
  if(mode==='exit-on-status'&&method==='status')process.exit(1);
  process.stdout.write(`${JSON.stringify(result===undefined?{id,error:{code:'invalid_operation'}}:{id,result})}\n`);
}
