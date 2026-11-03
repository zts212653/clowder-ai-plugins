import type { OperationRows } from "@clowder-ai/plugin-contract";
import type { SharedConnectionView } from "./connection.js";
import type { DotConnectionState } from "./connection-state.js";
import type { Dispatch } from "./store.js";

const FIVE_MINUTES_MS = 5 * 60_000;
const ROUNDTRIP_DEADLINE_MS = 60_000;

type JourneyAction =
	| "prepare-shared"
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
) {
	const ids = new Set(state.testEventIds);
	return dispatches
		.filter(
			(dispatch) =>
				ids.has(dispatch.eventId) && dispatch.attemptId === state.attemptId,
		)
		.sort((left, right) => right.occurredAt - left.occurredAt);
}

export interface DotJourneyInput {
	readonly runtimeRunning: boolean;
	readonly shared?: SharedConnectionView;
	readonly connection: DotConnectionState | null;
	readonly dispatches: readonly Dispatch[];
	readonly now: number;
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

	const shared = input.shared;
	if (
		!shared ||
		shared.deployment.state !== "configured" ||
		shared.binding.state === "occupied"
	) {
		const reason =
			shared?.binding.state === "occupied"
				? "现有猫咖云端连接已由另一个安装占用。"
				: shared?.deployment.state === "missing-endpoint"
					? "本实例尚未配置公开 HTTPS 共享入口。"
					: "本实例尚未配置可用的猫咖云端成员。";
		return {
			rows: [
				row(
					"deployment-blocked",
					"共享连接尚未准备好",
					`${reason} 这属于实例部署状态，请由本实例部署管理员补齐猫咖共享连接；Dot 不会生成地址、凭据或配对说明。`,
				),
			],
		};
	}

	if (shared.binding.state !== "active") {
		const reason =
			shared.binding.state === "needs-confirmation"
				? "安装或能力范围发生变化，需要重新确认。"
				: shared.binding.state === "revoked"
					? "此前授权已撤销。"
					: "Dot 尚未获准使用现有猫咖云端连接。";
		return {
			rows: [
				row("authorization-required", "需要确认共享连接范围", reason, [
					action("prepare-shared", "准备授权"),
				]),
			],
		};
	}

	const connection = input.connection;
	const current = connection?.revokedAt === null ? connection : null;
	if (!current) {
		return {
			rows: [
				row(
					"pairing-not-started",
					"共享入口已获准",
					"下一步生成一次 Dot 配对说明；此动作不会新建第二条猫咖连接。",
					[
						action("begin-pairing", "生成配对说明"),
						action("disconnect", "撤销共享授权"),
					],
				),
			],
		};
	}

	if (!activeSubscription(current, input.now)) {
		if (current.pairingExpiresAt <= input.now) {
			return {
				rows: [
					row(
						"pairing-expired",
						"配对说明已过期",
						"旧说明不能继续使用；重新生成只会旋转 Dot 配对，不会新建猫咖连接。",
						[
							action("reconnect", "重新生成配对说明"),
							action("disconnect", "断开连接"),
						],
					),
				],
			};
		}
		return {
			rows: [
				row(
					"waiting-subscription",
					"等待 ChatGPT 订阅",
					"复制当前配对说明，在已有猫咖 personal plugin 中 Refresh 后订阅 dot.summoned。",
					[
						action("show-instructions", "复制配对说明"),
						action("reconnect", "重新生成配对说明"),
						action("disconnect", "断开连接"),
					],
				),
			],
			pollUntil: Math.min(
				input.now + FIVE_MINUTES_MS,
				current.pairingExpiresAt,
			),
		};
	}

	const tests = currentTests(current, input.dispatches);
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
					[action("roundtrip", "再次测试"), action("disconnect", "断开连接")],
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
						action("show-instructions", "查看配对说明"),
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
