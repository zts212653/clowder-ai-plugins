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
	const replacementActions = external.current && external.pending
		? [action("cancel-pending", "放弃本次更新")]
		: [];
	const connectedActions = external.current ? replacementActions : [action("disconnect", "断开连接")];
	if (!endpointActive && (external.current?.kind === "signed" || external.pending || endpoint?.mode === "temporary-expired")) {
		const temporary = endpoint?.mode === "temporary-active" || endpoint?.mode === "temporary-expired";
		return {
			rows: [row(
				"endpoint-unavailable",
				temporary ? "临时入口已停止或到期" : "公网入口尚不可用",
				temporary
					? "请在上方点击「创建临时入口」，用返回的新 Server URL 在 ChatGPT 添加连接。"
					: "请在上方生成 Server URL，再将该 URL 添加到 ChatGPT。",
				[...replacementActions, action("disconnect", "断开连接")],
			)],
		};
	}
	if (!external.pending && external.current && !currentCredentialUsable) {
		return {
			rows: [row(
				"credential-unavailable",
				"外部凭据已不可用",
				"凭据已到期或失效。更新后请使用新 Server URL 在 ChatGPT 添加连接，并完成往返验证。",
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
				"等待入口确认",
				`尚未收到 ChatGPT 对此入口的工具与事件扫描。${endpointDetail}`,
				replacementActions,
			)],
			pollUntil: input.now + FIVE_MINUTES_MS,
		};
	}

    if (external.pending?.binding === null) {
        return { rows: [row("waiting-subscription", "等待新连接订阅", "生成订阅消息并在使用新 Server URL 的 ChatGPT 连接中发送。", replacementActions)], pollUntil: Math.min(input.now + FIVE_MINUTES_MS, external.pending.pairingIntent?.expiresAt ?? input.now + FIVE_MINUTES_MS) };
    }
	const connection = input.connection;
	const current = connection?.revokedAt === null ? connection : null;
	if (!current) {
		return {
			rows: [
				row(
					"pairing-not-started",
					"未连接",
					"尚未准备订阅消息。",
					replacementActions,
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
						"请在订阅消息区重新生成；现有 Server URL 仍可复用。",
						replacementActions,
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
					"尚未收到目标 Work 对话的订阅确认。",
					replacementActions,
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
			return { rows: [row("candidate-verification-required", external.current ? "验证新的外部凭据" : "已连接 · 待测试", external.current ? "现有连接会保留到新凭据验证成功。" : "需完成读取原消息和回复校验码的往返测试。", [action("roundtrip", "发起往返测试"), ...connectedActions])] };
		}
		if (pending.verificationReadAt !== null && pending.verificationReplyAt !== null) {
			return { rows: [row("candidate-promoting", "正在切换外部凭据", "新凭据的 discovery、读取与校验回复均已完成，正在提交切换。", [action("check-roundtrip", "检查状态")])], pollUntil: input.now + FIVE_MINUTES_MS };
		}
		const deadline = candidate.occurredAt + ROUNDTRIP_DEADLINE_MS;
		return {
			rows: [row(
				deadline > input.now ? "candidate-verification-pending" : "candidate-verification-timeout",
				deadline > input.now ? (external.current ? "正在验证新的外部凭据" : "测试中") : "往返测试尚未完成",
				pending.verificationReadAt !== null ? "已读取原消息，正在等待带校验码的回复。" : "正在等待读取本次测试消息。",
				[action("check-roundtrip", "检查状态"), ...connectedActions],
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
					"已连接 · 待测试",
					"还需要一次真实往返，确认 ChatGPT 能读取原消息并把校验回复送回猫咖。",
					[
						action("roundtrip", "发起往返测试"),
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
