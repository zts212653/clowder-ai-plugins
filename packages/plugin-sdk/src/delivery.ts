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

export type PluginCallHandler = (
	input: PluginMessageDelivery,
) => PluginDeliveryReceipt | Promise<PluginDeliveryReceipt>;
export interface PluginCallSurface {
	deliver(input: PluginMessageDelivery): Promise<PluginDeliveryReceipt>;
}

/** Receipt acknowledges this input only, never the execution outcome. */
export function defineDeliveryAction(
	handler: (
		input: PluginDeliveryInput,
	) => PluginDeliveryReceipt | Promise<PluginDeliveryReceipt>,
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

/** Fixed Host-owned call boundary for conversation-addressable plugin instances. */
export function defineCallDelivery(
	handler: PluginCallHandler,
): PluginCallSurface {
	const deliver = defineDeliveryAction((input) => {
		if (input.kind !== "message")
			throw new TypeError("plugin call accepts message delivery only");
		return handler(input);
	});
	return Object.freeze({
		deliver: (input: PluginMessageDelivery) => deliver(input),
	});
}
