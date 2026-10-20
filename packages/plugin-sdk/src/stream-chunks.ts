/** Internal stdio encoding. Module plugins consume Uint8Array iterators directly. */
import {validateMessagingRowInput,validateMessagingRowResult,type MessagingRowInputByMethod,type MessagingRowResultByMethod} from '@clowder-ai/plugin-contract';
import type {PluginStreams} from './streams.js';
type ReadChunk=(input:MessagingRowInputByMethod['streams.read'])=>Promise<MessagingRowResultByMethod['streams.read']>;
const CHUNK_BYTES=524288;
export function createStreamReader(readChunk:ReadChunk,assertCurrent:()=>void):PluginStreams {
 return {read(reference,options={}) {
  assertCurrent();if(typeof reference!=='string'||!reference.trim())throw new TypeError('stream reference must be non-empty');
  return {async *[Symbol.asyncIterator](){
   let offset=0;
   while(true){
    assertCurrent();options.signal?.throwIfAborted();
    const input=validateMessagingRowInput('streams.read',{reference,offset,limit:CHUNK_BYTES});
    if(!input.valid)throw new TypeError('invalid stream chunk input');
    const candidate=await readChunk(input.value);
    assertCurrent();options.signal?.throwIfAborted();
    const result=validateMessagingRowResult('streams.read',candidate);
    if(!result.valid)throw new TypeError('invalid stream chunk result');
    const chunk=result.value,bytes=Buffer.from(chunk.dataBase64,'base64');
    if(chunk.offset!==offset||bytes.length>CHUNK_BYTES)throw new TypeError('invalid stream chunk offset or size');
    if(chunk.done ? chunk.nextOffset!==undefined : bytes.length===0||chunk.nextOffset!==offset+bytes.length)throw new TypeError('invalid stream chunk cursor');
    if(bytes.length)yield new Uint8Array(bytes);
    if(chunk.done)return;
    offset=chunk.nextOffset!;
   }
  }};
 }};
}
