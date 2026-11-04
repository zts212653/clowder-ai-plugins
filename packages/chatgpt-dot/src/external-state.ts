import { z } from "zod";

const ref = z.string().min(1).max(512);

export const signedCredentialSchema = z
	.object({
		kind: z.literal("signed"),
		token: ref,
		tokenId: ref,
		issuedAt: z.number().int().nonnegative(),
		expiresAt: z.number().int().positive(),
		refreshRecommendedAt: z.number().int().positive(),
		verifiedEventId: ref.optional(),
	})
	.strict();

export const currentCredentialSchema = z.discriminatedUnion("kind", [
	signedCredentialSchema,
	z.object({ kind: z.literal("legacy"), recordRef: z.enum(["host.external", "connection.credentialSecret"]) }).strict(),
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
	.omit({ kind: true })
	.extend({
		kind: z.literal("pending"),
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
	.strict();

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
	readonly sub: string;
	readonly cap: string;
	readonly jti: string;
	readonly iat: number;
	readonly exp: number;
}
