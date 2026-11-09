import { fork, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLED_TUNNEL_SHA256 = "e528c46ff3826c7b0bcc4aa760734a92acd422b751c5dfca18fb7c27e129bf2b";

export interface TemporaryEndpointLease {
	readonly generation: string;
	readonly serverUrl: string;
	readonly startedAt: number;
	readonly expiresAt: number;
}

export interface TemporaryEndpointOptions {
	readonly runnerPath?: string;
	readonly binaryPath?: string;
	readonly now?: () => number;
	readonly fetch?: typeof fetch;
	readonly startupTimeoutMs?: number;
	readonly expectedBinarySha256?: string | null;
	readonly runtimeDirectory?: string;
	readonly onEnded?: (generation: string, reason: string) => void | Promise<void>;
}

type RunnerMessage =
	| { readonly type: "ready"; readonly publicBaseUrl: string }
	| { readonly type: "error"; readonly reason: string };

interface ActiveEndpoint {
	readonly generation: string;
	readonly child: ChildProcess;
	readonly timer: ReturnType<typeof setTimeout>;
	publicBaseUrl: string | null;
	readonly expiresAt: number;
	cleanup?: Promise<void>;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function transientProbeStatus(status: number): boolean {
	return status === 404 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function processGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (processGroupAlive(pid) && Date.now() < deadline) await pause(25);
	return !processGroupAlive(pid);
}

/** Activation-owned temporary ingress. No Host-specific process or endpoint policy lives here. */
export class TemporaryEndpointController {
	readonly #inActivation = AsyncLocalStorage.snapshot();
	readonly #runnerPath: string;
	readonly #binaryPath: string;
	readonly #usesBundledBinary: boolean;
	readonly #now: () => number;
	readonly #fetch: typeof fetch;
	readonly #startupTimeoutMs: number;
	readonly #expectedBinarySha256: string | null;
	readonly #runtimeDirectory: string | undefined;
	readonly #onEnded: TemporaryEndpointOptions["onEnded"];
	#epoch = 0;
	#active?: ActiveEndpoint;
	readonly #pendingCleanup = new Set<Promise<void>>();

	constructor(options: TemporaryEndpointOptions = {}) {
		this.#runnerPath = options.runnerPath ?? fileURLToPath(new URL("./temporary-endpoint-runner.mjs", import.meta.url));
		this.#binaryPath = options.binaryPath ?? fileURLToPath(new URL("../assets/bin/darwin-arm64/cloudflared", import.meta.url));
		this.#usesBundledBinary = options.binaryPath === undefined;
		this.#now = options.now ?? Date.now;
		this.#fetch = options.fetch ?? fetch;
		this.#startupTimeoutMs = options.startupTimeoutMs ?? 20_000;
		this.#expectedBinarySha256 = options.expectedBinarySha256 === undefined
			? (options.binaryPath === undefined ? BUNDLED_TUNNEL_SHA256 : null)
			: options.expectedBinarySha256;
		this.#runtimeDirectory = options.runtimeDirectory;
		this.#onEnded = options.onEnded;
	}

	async #prepareBinary(): Promise<string> {
		const info = await lstat(this.#binaryPath);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error("dot_temporary_binary_invalid");
		const bytes = await readFile(this.#binaryPath);
		const actual = createHash("sha256").update(bytes).digest("hex");
		if (this.#expectedBinarySha256 !== null && actual !== this.#expectedBinarySha256)
			throw new Error("dot_temporary_binary_mismatch");
		if (this.#runtimeDirectory === undefined) {
			if ((info.mode & 0o111) === 0) throw new Error("dot_temporary_binary_invalid");
			return this.#binaryPath;
		}
		await mkdir(this.#runtimeDirectory, { recursive: true, mode: 0o700 });
		await chmod(this.#runtimeDirectory, 0o700);
		const target = join(this.#runtimeDirectory, "cloudflared-darwin-arm64");
		const temporary = join(this.#runtimeDirectory, `.cloudflared-${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, bytes, { mode: 0o700, flag: "wx" });
			await chmod(temporary, 0o700);
			await rename(temporary, target);
			await chmod(target, 0o700);
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
		return target;
	}

	reserveStart(): number { return ++this.#epoch; }

	async start(input: {
		readonly upstreamLoopbackOrigin: string;
		readonly relativePath: string;
		readonly method: "POST";
		readonly token: string;
		readonly ttlMs: number;
	}, authority?: { readonly epoch: number; readonly beforeReplace: () => Promise<void> }): Promise<TemporaryEndpointLease> {
		if (this.#usesBundledBinary && (process.platform !== "darwin" || process.arch !== "arm64"))
			throw new Error("dot_temporary_platform_unsupported");
		if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > 24 * 60 * 60_000)
			throw new Error("dot_temporary_ttl_invalid");
		const epoch = authority?.epoch ?? this.reserveStart();
		if (epoch !== this.#epoch) throw new Error("dot_temporary_start_cancelled");
		const executablePath = await this.#prepareBinary();
		if (epoch !== this.#epoch) throw new Error("dot_temporary_start_cancelled");
		await authority?.beforeReplace();
		if (epoch !== this.#epoch) throw new Error("dot_temporary_start_cancelled");
		await this.#stopActive("replace");
		if (epoch !== this.#epoch) throw new Error("dot_temporary_start_cancelled");
		const generation = randomUUID();
		const child = fork(this.#runnerPath, [executablePath], {
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			env: { PATH: process.env.PATH ?? "" },
			detached: true,
		});
		const expiresAt = this.#now() + input.ttlMs;
		const timer = setTimeout(() => void this.stop("expired", generation), Math.max(1, expiresAt - this.#now()));
		timer.unref?.();
		const active: ActiveEndpoint = { generation, child, timer, publicBaseUrl: null, expiresAt };
		this.#active = active;
		const startupDeadline = Date.now() + this.#startupTimeoutMs;
		child.once("exit", () => {
			if (this.#active !== active) return;
			void this.#beginCleanup(active, "runner_exit", false);
		});
		try {
			const publicBaseUrl = await new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(
				() => settle(() => reject(new Error("dot_temporary_start_timeout"))),
				Math.max(1, startupDeadline - Date.now()),
			);
			const message = (raw: RunnerMessage) => {
				if (raw?.type === "ready") settle(() => resolve(raw.publicBaseUrl));
				else if (raw?.type === "error") settle(() => reject(new Error(raw.reason)));
			};
			const settle = (run: () => void) => {
				clearTimeout(timeout);
				child.off("exit", exited);
				child.off("message", message);
				run();
			};
			const exited = () => settle(() => reject(new Error("dot_temporary_runner_exited")));
			child.once("exit", exited);
			child.on("message", message);
			child.send({ type: "start", generation, ...input, expiresAt });
			});
			if (this.#active?.generation !== generation) throw new Error("dot_temporary_start_cancelled");
			this.#active.publicBaseUrl = publicBaseUrl;
			const probeUrl = `${publicBaseUrl.replace(/\/$/u, "")}/mcp`;
			for (;;) {
				if (this.#active?.generation !== generation) throw new Error("dot_temporary_start_cancelled");
				const remaining = startupDeadline - Date.now();
				if (remaining <= 0) throw new Error("dot_temporary_probe_failed");
				let status: number | undefined;
				try {
					status = (await this.#fetch(probeUrl, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{}",
						signal: AbortSignal.timeout(Math.max(1, Math.min(remaining, 2_000))),
					})).status;
				} catch {
					// Quick Tunnel can publish its URL before the edge route accepts traffic.
					// Network failures remain retryable only inside the original startup deadline.
				}
				if (status === 401) break;
				if (status !== undefined && !transientProbeStatus(status))
					throw new Error("dot_temporary_probe_failed");
				const afterProbe = startupDeadline - Date.now();
				if (afterProbe <= 0) throw new Error("dot_temporary_probe_failed");
				await pause(Math.min(250, afterProbe));
			}
			if (this.#active?.generation !== generation) throw new Error("dot_temporary_start_cancelled");
			return {
				generation,
				serverUrl: `${publicBaseUrl.replace(/\/$/u, "")}/mcp?token=${encodeURIComponent(input.token)}`,
				startedAt: this.#now(),
				expiresAt,
			};
		} catch (error) {
			if (this.#active === active) await this.#beginCleanup(active, "startup_failed", true);
			else await this.#awaitPendingCleanup();
			throw error;
		}
	}

	allowToken(token: string): TemporaryEndpointLease {
		const active = this.#active;
		if (!active || active.publicBaseUrl === null || active.child.exitCode !== null || active.child.signalCode !== null)
			throw new Error("dot_temporary_endpoint_unavailable");
		active.child.send({ type: "allow-token", token });
		return {
			generation: active.generation,
			serverUrl: `${active.publicBaseUrl.replace(/\/$/u, "")}/mcp?token=${encodeURIComponent(token)}`,
			startedAt: this.#now(),
			expiresAt: active.expiresAt,
		};
	}

	async stop(reason: string, expectedGeneration?: string): Promise<void> {
		if (expectedGeneration !== undefined) {
			const active = this.#active;
			if (!active || active.generation !== expectedGeneration) return;
			// Capture synchronously and do not invalidate a newer start's epoch.
			await this.#beginCleanup(active, reason, true);
			return;
		}
		this.#epoch += 1;
		await this.#stopActive(reason);
	}

	async #stopActive(reason: string): Promise<void> {
		const active = this.#active;
		if (!active) return this.#awaitPendingCleanup();
		await this.#beginCleanup(active, reason, true);
	}

	async #awaitPendingCleanup(): Promise<void> {
		if (this.#pendingCleanup.size === 0) return;
		await Promise.all([...this.#pendingCleanup]);
	}

	#beginCleanup(active: ActiveEndpoint, reason: string, requestRunnerStop: boolean): Promise<void> {
		if (active.cleanup) return active.cleanup;
		if (this.#active === active) this.#active = undefined;
		clearTimeout(active.timer);
		const cleanup = this.#cleanupOwnedGroup(active, reason, requestRunnerStop).finally(() => {
			this.#pendingCleanup.delete(cleanup);
		});
		active.cleanup = cleanup;
		this.#pendingCleanup.add(cleanup);
		return cleanup;
	}

	async #cleanupOwnedGroup(active: ActiveEndpoint, reason: string, requestRunnerStop: boolean): Promise<void> {
		const pid = active.child.pid;
		if (pid === undefined) throw new Error("dot_temporary_runner_pid_missing");
		if (requestRunnerStop && active.child.exitCode === null && active.child.signalCode === null) {
			const exited = new Promise<void>((resolve) => active.child.once("exit", () => resolve()));
			try { active.child.send({ type: "stop", reason }); }
			catch { /* The exit path below still owns the detached process group. */ }
			await Promise.race([exited, pause(1_500)]);
		}
		if (processGroupAlive(pid)) {
			try { process.kill(-pid, "SIGTERM"); }
			catch { /* The group may have completed between the liveness check and signal. */ }
			if (!await waitForProcessGroupExit(pid, 250)) {
				try { process.kill(-pid, "SIGKILL"); }
				catch { /* The group may have completed between the liveness check and signal. */ }
				await waitForProcessGroupExit(pid, 250);
			}
		}
		await this.#inActivation(() => this.#onEnded?.(active.generation, reason));
	}
}
