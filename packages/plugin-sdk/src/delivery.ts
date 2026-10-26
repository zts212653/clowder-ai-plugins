import {
	isPluginDeliveryInput,
	isPluginDeliveryReceipt,
	type PluginDeliveryInput,
	type PluginDeliveryReceipt,
	type PluginMessageDelivery,
} from "@clowder-ai/plugin-contract";

export type {
	PluginDeliveryInput,
	PluginDeliveryReceipt,
	PluginExecutionStatusDelivery,
	PluginMessageDelivery,
} from "@clowder-ai/plugin-contract";

export type PluginDeliverHandler = (
	input: PluginDeliveryInput,
) => PluginDeliveryReceipt | Promise<PluginDeliveryReceipt>;

/** Receipt acknowledges this input only, never the execution outcome. */
export function defineDeliveryAction(
	handler: PluginDeliverHandler,
) {
	return async (input: unknown): Promise<PluginDeliveryReceipt> => {
		if (!isPluginDeliveryInput(input))
			throw new TypeError("invalid plugin delivery");
		const snapshot = structuredClone(input),
			result = await handler(snapshot);
		if (
			!isPluginDeliveryReceipt(result) ||
			result.deliveryId !== snapshot.deliveryId
		)
			throw new TypeError("invalid delivery receipt");
		return structuredClone(result);
	};
}
