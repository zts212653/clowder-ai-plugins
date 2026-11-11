import { copyFile, chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(resolve(root, "dist"), { recursive: true });
await copyFile(
	resolve(root, "src/temporary-endpoint-runner.mjs"),
	resolve(root, "dist/temporary-endpoint-runner.mjs"),
);
await chmod(resolve(root, "dist/temporary-endpoint-runner.mjs"), 0o644);
