import { fork, type ChildProcess } from "node:child_process";
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
}

type RunnerMessage =
	| { readonly type: "ready"; readonly publicBaseUrl: string }
	| { readonly type: "error"; readonly reason: string };

/** Activation-owned temporary ingress. No Host-specific process or endpoint policy lives here. */
export class TemporaryEndpointController {
	readonly #runnerPath: string;
	readonly #binaryPath: string;
	readonly #now: () => number;
	readonly #fetch: typeof fetch;
	readonly #startupTimeoutMs: number;
	readonly #expectedBinarySha256: string | null;
	readonly #runtimeDirectory: string | undefined;
	#active?: { generation: string; child: ChildProcess; timer: ReturnType<typeof setTimeout>; publicBaseUrl: string | null; expiresAt: number };

	constructor(options: TemporaryEndpointOptions = {}) {
		this.#runnerPath = options.runnerPath ?? fileURLToPath(new URL("./temporary-endpoint-runner.mjs", import.meta.url));
		this.#binaryPath = options.binaryPath ?? fileURLToPath(new URL("../assets/bin/darwin-arm64/cloudflared", import.meta.url));
		this.#now = options.now ?? Date.now;
		this.#fetch = options.fetch ?? fetch;
		this.#startupTimeoutMs = options.startupTimeoutMs ?? 20_000;
		this.#expectedBinarySha256 = options.expectedBinarySha256 === undefined
			? (options.binaryPath === undefined ? BUNDLED_TUNNEL_SHA256 : null)
			: options.expectedBinarySha256;
		this.#runtimeDirectory = options.runtimeDirectory;
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

	async start(input: {
		readonly upstreamLoopbackOrigin: string;
		readonly relativePath: string;
		readonly method: "POST";
		readonly token: string;
		readonly ttlMs: number;
	}): Promise<TemporaryEndpointLease> {
		if (process.platform !== "darwin" || process.arch !== "arm64")
			throw new Error("dot_temporary_platform_unsupported");
		if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > 24 * 60 * 60_000)
			throw new Error("dot_temporary_ttl_invalid");
		const executablePath = await this.#prepareBinary();
		await this.stop("replace");
		const generation = randomUUID();
		const child = fork(this.#runnerPath, [executablePath], {
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			env: { PATH: process.env.PATH ?? "" },
		});
		const expiresAt = this.#now() + input.ttlMs;
		const timer = setTimeout(() => void this.stop("expired"), Math.max(1, expiresAt - this.#now()));
		timer.unref?.();
		this.#active = { generation, child, timer, publicBaseUrl: null, expiresAt };
		try {
			const publicBaseUrl = await new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => settle(() => reject(new Error("dot_temporary_start_timeout"))), this.#startupTimeoutMs);
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
			const probe = await this.#fetch(`${publicBaseUrl.replace(/\/$/u, "")}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
			signal: AbortSignal.timeout(this.#startupTimeoutMs),
			});
			if (probe.status !== 401) throw new Error("dot_temporary_probe_failed");
			if (this.#active?.generation !== generation) throw new Error("dot_temporary_start_cancelled");
			return {
				generation,
				serverUrl: `${publicBaseUrl.replace(/\/$/u, "")}/mcp?token=${encodeURIComponent(input.token)}`,
				startedAt: this.#now(),
				expiresAt,
			};
		} catch (error) {
			if (this.#active?.generation === generation) await this.stop("startup_failed");
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

	async stop(reason: string): Promise<void> {
		const active = this.#active;
		if (!active) return;
		this.#active = undefined;
		clearTimeout(active.timer);
		if (active.child.exitCode !== null || active.child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				if (active.child.exitCode === null && active.child.signalCode === null) active.child.kill("SIGKILL");
			}, 2_000);
			active.child.once("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
			active.child.send({ type: "stop", reason });
		});
	}
}
