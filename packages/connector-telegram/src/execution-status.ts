/** Platform feedback business state. Delivery is the only Host callback. */
import {isPluginDeliveryInput,type PluginExecutionStatusDelivery} from '@clowder-ai/plugin-contract';
import {isDeepStrictEqual} from 'node:util';
export type ExecutionStatus=PluginExecutionStatusDelivery;
export type LifecycleAction=(input:ExecutionStatus)=>{readonly deliveryId:string}|Promise<{readonly deliveryId:string}>;
function requireStatus(input:unknown):ExecutionStatus {
 if(!isPluginDeliveryInput(input)||input.kind!=='execution_status')throw new TypeError('invalid execution status delivery');
 return structuredClone(input);
}
export function defineLifecycleAction(handler:LifecycleAction) {
 return async(input:unknown)=>{const status=requireStatus(input),result=await handler(status);
  if(!result||Object.keys(result).length!==1||result.deliveryId!==status.deliveryId)throw new TypeError('invalid execution status receipt');
  return result;
 };
}
export function lifecycleRejectReason(decision:{reason:'OUT_OF_ORDER'|'DELIVERY_CONFLICT'|'INVALID_HISTORY'}) {
 return decision.reason==='OUT_OF_ORDER'?'EXECUTION_OUT_OF_ORDER':decision.reason==='DELIVERY_CONFLICT'?'EXECUTION_DELIVERY_CONFLICT':'PLUGIN_INTERNAL';
}
type Decision={kind:'accept'}|{kind:'replay'}|{kind:'reject';reason:'DELIVERY_CONFLICT'|'INVALID_HISTORY'|'OUT_OF_ORDER'};
function next(history:readonly ExecutionStatus[],event:ExecutionStatus):Decision {
  const duplicate=history.find(row=>row.deliveryId===event.deliveryId);
  if(duplicate)return isDeepStrictEqual(duplicate,event)?{kind:'replay'}:{kind:'reject',reason:'DELIVERY_CONFLICT'};
  if(history.some(row=>row.executionId!==event.executionId||row.threadId!==event.threadId))return {kind:'reject',reason:'INVALID_HISTORY'};
  if(!history.length)return event.state==='started'?{kind:'accept'}:{kind:'reject',reason:'OUT_OF_ORDER'};
  const last=history.at(-1)!;
  if(last.state==='settled'||event.state==='started'||event.state==='resumed'&&last.state!=='blocked'||last.state==='blocked'&&!['resumed','settled'].includes(event.state))return {kind:'reject',reason:'OUT_OF_ORDER'};
  return {kind:'accept'};
}
export function decideLifecycleTransition(historyInput:readonly unknown[],eventInput:unknown):Decision {
  try {
    const history:ExecutionStatus[]=[];
    for(const input of historyInput){const event=requireStatus(input);if(next(history,event).kind!=='accept')return {kind:'reject',reason:'INVALID_HISTORY'};history.push(event);}
    return next(history,requireStatus(eventInput));
  }catch{return {kind:'reject',reason:'INVALID_HISTORY'};}
}
