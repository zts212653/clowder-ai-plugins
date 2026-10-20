import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import test from 'node:test';
import {dotSigningKey,dotWebhookHeaders,verifyDotWebhook} from '../src/dot-webhook.ts';
import {resolveExternalUrl,validateExternalUrl} from '../src/url-safety.ts';
import {parseDotProxyUrl} from '../src/dot-proxy-tls.ts';

test('callback verification and secret rotation use the unchanged signed webhook protocol',async()=>{
 const secret='whsec_'+Buffer.alloc(32,7).toString('base64'),previous='whsec_'+Buffer.alloc(32,8).toString('base64');
 const headers=dotWebhookHeaders('event','subscription',secret,'{}',123000,previous);
 const expected=createHmac('sha256',dotSigningKey(secret)).update('event.123.{}').digest('base64');
 assert.ok(headers['webhook-signature'].includes('v1,'+expected));assert.equal(headers['X-MCP-Subscription-Id'],'subscription');
 await verifyDotWebhook('https://callbacks.example/dot','sub',secret,async(_url,_headers,body)=>({status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})}));
 await assert.rejects(()=>verifyDotWebhook('https://callbacks.example/dot','sub',secret,async()=>({status:200,body:'{"challenge":"wrong"}'})),/challenge/);
});

test('callback DNS re-resolution rejects private, reserved and mapped addresses before connecting',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','::1','::ffff:127.0.0.1','2001:db8::1'])
   await assert.rejects(()=>resolveExternalUrl('https://callbacks.example/dot',async()=>[{address:ip}]));
 await assert.rejects(()=>verifyDotWebhook('https://user:pass@example.com/','sub','whsec_'+Buffer.alloc(32,1).toString('base64')));
 for(const url of ['http://10.0.0.1:8888','https://127.0.0.1:8888','http://127.0.0.1:8888/path','http://user:pass@127.0.0.1:8888'])assert.throws(()=>parseDotProxyUrl(url));
 assert.equal(parseDotProxyUrl('http://127.0.0.1:8888').port,'8888');
});
