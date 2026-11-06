import type { OperationRows } from "@clowder-ai/plugin-contract";
import type { DotConnectionState } from "./connection-state.js";
import type { DotExternalState } from "./external-state.js";
import type { Dispatch } from "./store.js";

const FIVE_MINUTES_MS = 5 * 60_000;
const ROUNDTRIP_DEADLINE_MS = 60_000;

type JourneyAction =
	| "show-server-url"
	| "stop-temporary"
	| "refresh-credential"
	| "cancel-pending"
	| "begin-pairing"
	| "show-instructions"
	| "reconnect"
	| "roundtrip"
	| "check-roundtrip"
	| "disconnect";

function action(action: JourneyAction, label: string) {
	return { action, label, input: { journey: action } } as const;
}

function row(
	key: string,
	label: string,
	detail: string,
	actions: ReturnType<typeof action>[] = [],
) {
	return { key, label, detail, ...(actions.length === 0 ? {} : { actions }) };
}

function activeSubscription(state: DotConnectionState, now: number) {
	return Boolean(
		state.subscription &&
			(state.subscription.expiresAt === null ||
				state.subscription.expiresAt > now),
	);
}

function currentTests(
	state: DotConnectionState,
	dispatches: readonly Dispatch[],
	verifiedEventId?: string,
) {
	const ids = new Set(state.testEventIds);
	return dispatches
		.filter(
			(dispatch) =>
				ids.has(dispatch.eventId) &&
				dispatch.attemptId === state.attemptId &&
				(verifiedEventId === undefined || dispatch.eventId === verifiedEventId),
		)
		.sort((left, right) => right.occurredAt - left.occurredAt);
}

export interface DotJourneyInput {
	readonly runtimeRunning: boolean;
	readonly external: DotExternalState | null;
	readonly connection: DotConnectionState | null;
	readonly dispatches: readonly Dispatch[];
	readonly now: number;
	readonly credentialStatus?: {
		readonly usable: boolean;
		readonly reason: string;
		readonly refreshRecommended?: boolean;
	};
}

export function projectDotJourney(input: DotJourneyInput): OperationRows {
	if (!input.runtimeRunning) {
		return {
			rows: [
				row(
					"runtime-unavailable",
					"Dot 尚未运行",
					"先在插件卡片恢复运行；此状态不会创建授权或配对。",
				),
			],
		};
	}

	const external = input.external;
	const endpoint = external?.endpoint;
	const currentCredentialUsable = !external?.current || external.current.kind === "legacy"
		? true
		: input.credentialStatus?.usable ?? external.current.expiresAt * 1000 > input.now;
	const endpointActive = Boolean(
		endpoint &&
			(endpoint.mode === "long-lived" ||
				(endpoint.mode === "temporary-active" && endpoint.expiresAt > input.now)),
	);
	if (!external?.pending && !external?.current) {
		return { rows: [], pollUntil: input.now + FIVE_MINUTES_MS };
	}
	if (!external.pending && external.current && !currentCredentialUsable) {
		return {
			rows: [row(
				"credential-unavailable",
				"外部凭据已不可用",
				"现有连接不会被旧往返记录伪装成可用；请生成并验证新的外部凭据。",
				[action("refresh-credential", "更新外部凭据"), action("disconnect", "断开连接")],
			)],
		};
	}
	if (!external.pending && !endpointActive) {
		return { rows: [], pollUntil: input.now + FIVE_MINUTES_MS };
	}
	if (!endpointActive) {
		return { rows: [], pollUntil: input.now + FIVE_MINUTES_MS };
	}
	if (external.pending?.discoveredAt === null) {
		const endpointDetail = endpoint?.mode === "temporary-active"
			? `这是临时入口，将于 ${new Date(endpoint.expiresAt).toISOString()} 到期。`
			: "这是已配置的长期公网入口。";
		return {
			rows: [row(
				"waiting-discovery",
				"第二步：添加到 ChatGPT",
				`把上方生成的 Server URL 添加到 https://chatgpt.com/plugins，Authentication 选择「No authentication」。添加后点「生成订阅消息」，在目标 Work 对话中 @ 刚添加的插件并发送消息。${endpointDetail}`,
				[
					action("show-instructions", "生成订阅消息"),
				],
			)],
			pollUntil: input.now + FIVE_MINUTES_MS,
		};
	}

	const connection = input.connection;
	const current = connection?.revokedAt === null ? connection : null;
	if (!current) {
		return {
			rows: [
				row(
					"pairing-not-started",
					"第四步：生成订阅消息",
					"点「生成订阅消息」并复制结果。在 ChatGPT Work 的目标对话输入 @，选择刚添加的插件，再发送这条消息。",
					[
						action("show-instructions", "生成订阅消息"),
					],
				),
			],
			pollUntil: input.now + FIVE_MINUTES_MS,
		};
	}

	if ((!external.pending || external.pending.pairingRequired !== false) && !activeSubscription(current!, input.now)) {
		if (current.pairingExpiresAt <= input.now) {
			return {
				rows: [
					row(
						"pairing-expired",
						"订阅消息已过期",
						"重新生成订阅消息，发送到目标 ChatGPT Work 对话；无需重新生成仍有效的 Server URL。",
						[
							action("show-instructions", "生成订阅消息"),
						],
					),
				],
				pollUntil: input.now + FIVE_MINUTES_MS,
			};
		}
		return {
			rows: [
				row(
					"waiting-subscription",
					"第五步：等待 ChatGPT 订阅",
					"将生成的订阅消息发送到目标 Work 对话并允许订阅。这里会自动更新；若已发送但仍未连接，请查看 ChatGPT 调用详情中的错误。",
					[
						action("show-instructions", "生成订阅消息"),
					],
				),
			],
			pollUntil: Math.min(
				input.now + FIVE_MINUTES_MS,
				current.pairingExpiresAt,
			),
		};
	}

	if (external.pending) {
		const pending = external.pending;
		if (pending.pairingAttemptId !== current!.attemptId) {
			return { rows: [row("candidate-pairing-mismatch", "待验证凭据与当前配对不一致", "请放弃本次更新后重新开始。", [action("cancel-pending", "放弃本次更新")])] };
		}
		const candidate = pending.verificationEventId === null
			? undefined
			: input.dispatches.find((dispatch) => dispatch.eventId === pending.verificationEventId && dispatch.attemptId === current!.attemptId);
		if (pending.verificationEventId === null || !candidate) {
			return { rows: [row("candidate-verification-required", "验证新的外部凭据", "现有配对已保留；发起一次仅属于新凭据的真实往返，成功后才会替换旧凭据。", [action("roundtrip", "验证新凭据"), action("cancel-pending", "放弃本次更新")])] };
		}
		if (pending.verificationReadAt !== null && pending.verificationReplyAt !== null) {
			return { rows: [row("candidate-promoting", "正在切换外部凭据", "新凭据的 discovery、读取与校验回复均已完成，正在提交切换。", [action("check-roundtrip", "检查状态")])], pollUntil: input.now + FIVE_MINUTES_MS };
		}
		const deadline = candidate.occurredAt + ROUNDTRIP_DEADLINE_MS;
		return {
			rows: [row(
				deadline > input.now ? "candidate-verification-pending" : "candidate-verification-timeout",
				deadline > input.now ? "正在验证新的外部凭据" : "新凭据验证尚未完成",
				pending.verificationReadAt !== null ? "新凭据已读取原消息，正在等待带校验码的回复。" : "正在等待新凭据读取本次测试消息。",
				[action("check-roundtrip", "检查状态"), action("cancel-pending", "放弃本次更新")],
			)],
			...(deadline > input.now ? { pollUntil: deadline } : {}),
		};
	}

	const tests = currentTests(current!, input.dispatches,
		external.current?.kind === "signed" ? external.current.verifiedEventId : undefined);
	const completed = tests.find(
		(test) => test.sourceReadAt !== null && test.replyMessageId !== null,
	);
	if (completed) {
		return {
			rows: [
				row(
					"ready",
					"Dot 已可用",
					`最近一次真实往返已读取原消息并回复（${new Date(completed.occurredAt).toISOString()}）。`,
					[
						action("roundtrip", "再次测试"),
						...(input.credentialStatus?.refreshRecommended ? [action("refresh-credential", "更新外部凭据")] : []),
						action("disconnect", "断开连接"),
					],
				),
			],
		};
	}

	const latest = tests[0];
	if (!latest) {
		return {
			rows: [
				row(
					"verification-required",
					"订阅已验证",
					"还需要一次真实往返，确认 ChatGPT 能读取原消息并把校验回复送回猫咖。",
					[
						action("roundtrip", "发起往返测试"),
						action("show-instructions", "生成订阅消息"),
						action("disconnect", "断开连接"),
					],
				),
			],
		};
	}

	if (latest.deliveryError) {
		return {
			rows: [
				row(
					"verification-failed",
					"往返通知未送达",
					"通知未送达 ChatGPT；本次失败证据已保留，可以重新测试。",
					[
						action("roundtrip", "重新测试"),
						action("check-roundtrip", "检查状态"),
						action("disconnect", "断开连接"),
					],
				),
			],
		};
	}

	const deadline = latest.occurredAt + ROUNDTRIP_DEADLINE_MS;
	if (deadline > input.now) {
		const progress =
			latest.sourceReadAt !== null
				? "ChatGPT 已读取测试原消息，正在等待带校验码的回复。"
				: latest.webhookAcknowledgedAt !== null
					? "ChatGPT 已收到通知，正在等待读取测试原消息。"
					: "测试已创建，正在等待 ChatGPT 接收通知。";
		return {
			rows: [
				row("verification-pending", "正在验证真实往返", progress, [
					action("check-roundtrip", "检查测试结果"),
					action("disconnect", "断开连接"),
				]),
			],
			pollUntil: deadline,
		};
	}

	const diagnosis =
		latest.sourceReadAt !== null
			? "ChatGPT 已读取原消息，但在 60 秒内没有回传正确校验码。"
			: latest.webhookAcknowledgedAt !== null
				? "ChatGPT 已收到通知，但在 60 秒内没有读取测试原消息。"
				: "在 60 秒内没有收到 ChatGPT 的通知确认。";
	return {
		rows: [
			row("verification-timeout", "往返测试尚未完成", diagnosis, [
				action("roundtrip", "重新测试"),
				action("check-roundtrip", "检查状态"),
				action("disconnect", "断开连接"),
			]),
		],
	};
}
