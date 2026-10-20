import {isPluginDeliveryInput,isPluginDeliveryReceipt,type PluginDeliveryInput,type PluginDeliveryReceipt} from '@clowder-ai/plugin-contract';
export type {PluginDeliveryInput,PluginDeliveryReceipt,PluginMessageDelivery,PluginExecutionStatusDelivery} from '@clowder-ai/plugin-contract';
/** Receipt acknowledges this input only, never the execution outcome. */
export function defineDeliveryAction(handler:(input:PluginDeliveryInput)=>PluginDeliveryReceipt|Promise<PluginDeliveryReceipt>) {
  return async(input:unknown):Promise<PluginDeliveryReceipt>=>{
    if(!isPluginDeliveryInput(input))throw new TypeError('invalid plugin delivery');
    const snapshot=structuredClone(input),result=await handler(snapshot);
    if(!isPluginDeliveryReceipt(result)||result.deliveryId!==snapshot.deliveryId)throw new TypeError('invalid delivery receipt');
    return structuredClone(result);
  };
}
