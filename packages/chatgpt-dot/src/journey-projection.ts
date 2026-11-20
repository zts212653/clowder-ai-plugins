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
	| "reconnect"
	| "roundtrip"
	| "retry-verification"
	| "repair-subscription"
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

function waitingConnection(now: number): OperationRows {
	return {
		rows: [row("waiting-connection", "待连接", "")],
		pollUntil: now + FIVE_MINUTES_MS,
	};
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
	readonly verificationJob?: import("./automatic-verification.js").VerificationJob;
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

function projectDotJourneyDetails(input: DotJourneyInput): OperationRows {
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
	const currentCredentialUsable =
		!external?.current || external.current.kind === "legacy"
			? true
			: (input.credentialStatus?.usable ??
				(external.current.expiresAt === null ||
					external.current.expiresAt * 1000 > input.now));
	const endpointActive = Boolean(
		endpoint &&
			(endpoint.mode === "long-lived" ||
				(endpoint.mode === "temporary-active" &&
					endpoint.expiresAt > input.now)),
	);
	if (!external?.pending && !external?.current) {
		return waitingConnection(input.now);
	}
	if (
		!endpointActive &&
		((external.current && external.current.kind !== "legacy") ||
			external.pending ||
			endpoint?.mode === "temporary-expired")
	) {
		const temporary =
			endpoint?.mode === "temporary-active" ||
			endpoint?.mode === "temporary-expired";
		return {
			rows: [
				row(
					"endpoint-unavailable",
					temporary ? "临时入口已停止或到期" : "公网入口尚不可用",
					temporary
						? "请在上方点击「创建临时入口」，用返回的新 Server URL 在 ChatGPT 添加连接。"
						: "请在上方生成 Server URL，再将该 URL 添加到 ChatGPT。",
				),
			],
		};
	}
	if (
		(external.pending &&
			external.pending.expiresAt !== null &&
			external.pending.expiresAt * 1000 <= input.now) ||
		(!external.pending && external.current && !currentCredentialUsable)
	) {
		return {
			rows: [
				row(
					"credential-unavailable",
					"外部凭据已不可用",
					"请在上方重新生成 Server URL，再在 ChatGPT 添加连接并发送订阅消息。",
				),
			],
		};
	}
	if (!external.pending && !endpointActive) {
		return waitingConnection(input.now);
	}
	if (!endpointActive) {
		return waitingConnection(input.now);
	}
	if (external.pending?.discoveredAt === null) {
		const endpointDetail =
			endpoint?.mode === "temporary-active"
				? `这是临时入口，将于 ${new Date(endpoint.expiresAt).toISOString()} 到期。`
				: "这是已配置的长期公网入口。";
		return {
			rows: [
				row(
					"waiting-discovery",
					"等待入口确认",
					`尚未收到 ChatGPT 对此入口的工具与事件扫描。${endpointDetail}`,
				),
			],
			pollUntil: input.now + FIVE_MINUTES_MS,
		};
	}

	if (
		external.pending &&
		input.connection?.revokedAt === null &&
		((external.pending.pairingAttemptId &&
			external.pending.pairingAttemptId !== input.connection.attemptId) ||
			(external.pending.binding &&
				external.pending.binding.attemptId !== input.connection.attemptId))
	) {
		return {
			rows: [
				row(
					"candidate-pairing-mismatch",
					"待验证凭据与当前配对不一致",
					"重新生成订阅消息，在使用当前 Server URL 的 ChatGPT 连接中发送。",
					[action("repair-subscription", "重新连接")],
				),
			],
		};
	}
	if (external.pending?.binding === null) {
		if (
			external.pending.pairingIntent &&
			external.pending.pairingIntent.expiresAt <= input.now
		)
			return {
				rows: [
					row(
						"pairing-expired",
						"订阅消息已过期",
						"重新生成订阅消息后，在使用当前 Server URL 的目标 Work 对话中发送。",
						[action("repair-subscription", "重新生成订阅消息")],
					),
				],
			};
		return {
			rows: [
				row(
					"waiting-subscription",
					"等待新连接订阅",
					"生成订阅消息并在使用新 Server URL 的 ChatGPT 连接中发送。",
				),
			],
			pollUntil: Math.min(
				input.now + FIVE_MINUTES_MS,
				external.pending.pairingIntent?.expiresAt ??
					input.now + FIVE_MINUTES_MS,
			),
		};
	}
	const connection = input.connection;
	const current = connection?.revokedAt === null ? connection : null;
	if (!current) {
		return {
			rows: [
				row(
					"pairing-not-started",
					"未连接",
					"请在上方生成订阅消息，再到目标 Work 对话发送并允许订阅。",
				),
			],
			pollUntil: input.now + FIVE_MINUTES_MS,
		};
	}

	if (
		(!external.pending ||
			external.pending.binding !== undefined ||
			external.pending.pairingRequired !== false) &&
		!activeSubscription(current!, input.now)
	) {
		if (current!.subscription && current!.pairedAt !== null) {
			return {
				rows: [
					row(
						"subscription-expired",
						"订阅已失效",
						"重新生成订阅消息后，在原 ChatGPT 连接的目标 Work 对话中发送并允许订阅。",
						[action("repair-subscription", "重新连接")],
					),
				],
			};
		}
		if (current.pairingExpiresAt <= input.now) {
			return {
				rows: [
					row(
						"pairing-expired",
						"订阅消息已过期",
						"请在订阅消息区重新生成；现有 Server URL 仍可复用。",
						[action("repair-subscription", "重新生成订阅消息")],
					),
				],
				pollUntil: input.now + FIVE_MINUTES_MS,
			};
		}
		return {
			rows: [
				row(
					"waiting-subscription",
					"等待订阅",
					"请在目标 Work 对话发送上方生成的订阅消息并允许订阅；尚未收到确认。",
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
		const candidate =
			pending.verificationEventId === null
				? undefined
				: input.dispatches.find(
						(dispatch) =>
							dispatch.eventId === pending.verificationEventId &&
							dispatch.attemptId === current!.attemptId,
					);
		if (pending.verificationEventId === null || !candidate) {
			return {
				rows: [
					row(
						"candidate-verification-required",
						external.current ? "验证新的外部凭据" : "已连接 · 待测试",
						external.current
							? "现有连接会保留到新凭据验证成功。"
							: "需完成读取原消息和回复校验码的往返测试。",
						[action("roundtrip", "发起往返测试")],
					),
				],
			};
		}
		if (
			pending.verificationReadAt !== null &&
			pending.verificationReplyAt !== null
		) {
			return {
				rows: [
					row(
						"candidate-promoting",
						"正在切换外部凭据",
						"新凭据的 discovery、读取与校验回复均已完成，正在提交切换。",
					),
				],
				pollUntil: input.now + FIVE_MINUTES_MS,
			};
		}
		const deadline = candidate.occurredAt + ROUNDTRIP_DEADLINE_MS;
		return {
			rows: [
				row(
					deadline > input.now
						? "candidate-verification-pending"
						: "candidate-verification-timeout",
					deadline > input.now
						? external.current
							? "正在验证新的外部凭据"
							: "测试中"
						: "往返测试尚未完成",
					pending.verificationReadAt !== null
						? "已读取原消息，正在等待带校验码的回复。"
						: "正在等待读取本次测试消息。",
					deadline > input.now ? [] : [action("retry-verification", "重试验证")],
				),
			],
			...(deadline > input.now ? { pollUntil: deadline } : {}),
		};
	}

	const tests = currentTests(
		current!,
		input.dispatches,
		external.current && external.current.kind !== "legacy"
			? external.current.verificationGeneration
				? (input.verificationJob?.eventId ??
					external.current.verifiedEventId ??
					"awaiting-current-verification")
				: external.current.verifiedEventId
			: undefined,
	);
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
					[action("disconnect", "断开连接")],
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
					"已连接 · 待测试",
					"还需要一次真实往返，确认 ChatGPT 能读取原消息并把校验回复送回猫咖。",
					[action("roundtrip", "发起往返测试")],
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
					[action("roundtrip", "重新测试")],
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
				row("verification-pending", "正在验证真实往返", progress),
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
			]),
		],
	};
}

/** The owner watches automatic verification; only a failed attempt asks for an action. */
export function projectDotJourney(input: DotJourneyInput): OperationRows {
	const result = projectDotJourneyDetails(input);
	if (
		input.verificationJob?.stage === "failed" &&
		[
			"candidate-verification-required",
			"candidate-verification-pending",
			"candidate-verification-timeout",
			"candidate-promoting",
			"verification-required",
			"verification-pending",
			"verification-failed",
			"verification-timeout",
		].includes(result.rows[0]?.key ?? "")
	)
		return {
			rows: [
				row(
					"automatic-verification-failed",
					"自动连接验证未完成",
					input.verificationJob.error === "dot_verification_creation_unknown"
						? "上次创建验证对话时中断，无法确认创建结果。点击重试后重新准备；已保存的连接不会被替换。"
						: "本次验证未完成，已有测试消息和校验记录会在重试时复用。",
					[action("retry-verification", "重试验证")],
				),
			],
		};
	return {
		...result,
		rows: result.rows.map(({ actions: declaredActions, ...item }) => {
			const needsStart = [
				"verification-required",
				"candidate-verification-required",
			].includes(item.key);
			const failed = /timeout|failed/.test(item.key);
			const actions = (declaredActions ?? [])
				.filter((a) => failed || a.action !== "roundtrip")
				.map((a) =>
					a.action === "roundtrip"
						? action("retry-verification", "重试验证")
						: a,
				);
			return {
				...item,
				...(needsStart
					? {
							label: input.external?.current
								? "正在自动验证新的连接"
								: "正在自动验证连接",
							detail:
								"订阅已建立，插件会自动发送测试消息，确认读取原文及校验码回复。",
						}
					: {}),
				...(actions.length ? { actions } : {}),
			};
		}),
		...(result.rows.some((item) =>
			["verification-required", "candidate-verification-required"].includes(
				item.key,
			),
		)
			? { pollUntil: input.now + FIVE_MINUTES_MS }
			: {}),
	};
}
