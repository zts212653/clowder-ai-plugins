import { z } from "zod";
import { dotSubscriptionSchema } from "./connection-state.js";

const ref = z.string().min(1).max(512);

export const callbackBindingSchema = z
	.object({
		attemptId: ref,
		pairingCode: ref,
		pairingExpiresAt: z.number(),
		version: z.number().int().positive(),
		pairedCallbackUrl: z.string().url().nullable(),
		pairedAt: z.number().nullable(),
		subscription: dotSubscriptionSchema.nullable(),
	})
	.strict();
export type CallbackBinding = z.infer<typeof callbackBindingSchema>;

export const signedCredentialSchema = z
	.object({
		kind: z.literal("signed"),
		token: ref,
		tokenId: ref,
		issuedAt: z.number().int().nonnegative(),
		expiresAt: z.number().int().positive(),
		refreshRecommendedAt: z.number().int().positive(),
		verifiedEventId: ref.optional(),
		binding: callbackBindingSchema.optional(),
	})
	.strict();

export const currentCredentialSchema = z.discriminatedUnion("kind", [
	signedCredentialSchema,
	signedCredentialSchema.extend({
		kind: z.literal("plugin"),
		pluginInstanceId: ref,
		expiresAt: z.number().int().positive().nullable(),
		refreshRecommendedAt: z.number().int().positive().nullable(),
	}),
	z
		.object({
			kind: z.literal("legacy"),
			recordRef: z.enum(["host.external", "connection.credentialSecret"]),
		})
		.strict(),
]);

export const endpointLeaseSchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("absent") }).strict(),
	z
		.object({
			mode: z.literal("long-lived"),
			serverUrl: z.string().url().max(4096),
			reachableAt: z.number().int().nonnegative().nullable(),
		})
		.strict(),
	z
		.object({
			mode: z.literal("temporary-active"),
			serverUrl: z.string().url().max(4096),
			generation: ref,
			startedAt: z.number().int().nonnegative(),
			expiresAt: z.number().int().positive(),
			reachableAt: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			mode: z.literal("temporary-expired"),
			generation: ref,
			expiresAt: z.number().int().positive(),
		})
		.strict(),
]);

export const pendingCredentialSchema = signedCredentialSchema
	.omit({ kind: true, binding: true })
	.extend({
		kind: z.literal("pending"),
		issuer: z.literal("plugin").optional(),
		pluginInstanceId: ref.optional(),
		expiresAt: z.number().int().positive().nullable(),
		refreshRecommendedAt: z.number().int().positive().nullable(),
		binding: callbackBindingSchema.nullable().optional(),
		pairingIntent: z
			.object({ code: ref, expiresAt: z.number(), attemptId: ref })
			.strict()
			.optional(),
		verificationBindingVersion: z.number().int().positive().optional(),
		candidateId: ref,
		revision: z.number().int().positive(),
		createdAt: z.number().int().nonnegative(),
		discoveredAt: z.number().int().nonnegative().nullable(),
		pairingAttemptId: ref.nullable(),
		pairingRequired: z.boolean().default(true),
		verificationEventId: ref.nullable(),
		verificationReadAt: z.number().int().nonnegative().nullable(),
		verificationReplyAt: z.number().int().nonnegative().nullable(),
		/** Snapshot restored when an owner abandons a credential replacement. */
		previousEndpoint: endpointLeaseSchema.nullable().optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.issuer === "plugin" && !value.pluginInstanceId)
			context.addIssue({code:z.ZodIssueCode.custom,message:"Plugin credentials require their issuing installation"});
		if (
			value.issuer !== "plugin" &&
			(value.expiresAt === null || value.refreshRecommendedAt === null)
		)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Host-signed pending credentials require expiry metadata",
			});
	});

export const dotExternalStateSchema = z
	.object({
		v: z.literal(1),
		revision: z.number().int().positive(),
		current: currentCredentialSchema.nullable(),
		pending: pendingCredentialSchema.nullable(),
		endpoint: endpointLeaseSchema,
	})
	.strict();

export type SignedCredential = z.infer<typeof signedCredentialSchema>;
export type PendingCredential = z.infer<typeof pendingCredentialSchema>;
export type DotExternalState = z.infer<typeof dotExternalStateSchema>;

export interface VerifiedExternalCredential {
	readonly origin?: "plugin";
	readonly sub: string;
	readonly cap: string;
	readonly jti: string;
	readonly iat: number;
	readonly exp: number | null;
}

export const credentialLive = (
	credential: { readonly expiresAt: number | null },
	now: number,
) => credential.expiresAt === null || credential.expiresAt * 1000 > now;
