import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { validateManifest } from "../../plugin-contract/src/validation/manifest.ts";

test("entry mode is one selector with branch-owned long-lived and temporary controls", async () => {
	const manifest = parseYaml(
		await readFile(
			fileURLToPath(new URL("../plugin.yaml", import.meta.url)),
			"utf8",
		),
	);
	const validation = validateManifest(manifest);
	assert.equal(validation.valid, true, JSON.stringify(validation.errors));
	assert.match(manifest.steps[1].text, /https:\/\/chatgpt\.com\/plugins/);
	assert.match(manifest.steps[1].text, /Add custom MCP server/);
	assert.match(manifest.steps[1].text, /No authentication/);
	assert.deepEqual(manifest.configurationVariants, {
		discriminator: "endpointMode",
		branches: [
			{
				id: "long-lived",
				when: { properties: { endpointMode: { const: "long-lived" } } },
				fields: [
					"longLivedServerUrlTemplate",
					"externalTokenDays",
					"longLivedEndpoint",
				],
			},
			{
				id: "temporary",
				when: { properties: { endpointMode: { const: "temporary" } } },
				fields: ["temporaryEndpointHours", "temporaryEndpoint"],
			},
		],
	});
	const fields = new Map(
		manifest.configuration.map((field) => [field.key, field]),
	);
	assert.equal(fields.get("endpointMode")?.kind, "select");
	assert.equal(fields.get("endpointMode")?.default, "temporary");
	assert.equal(fields.get("longLivedServerUrlTemplate")?.required, true);
	assert.deepEqual(
		fields
			.get("longLivedEndpoint")
			?.actions.map(({ id, render, resultRender, next, action }) => ({
				id,
				render,
				resultRender,
				next,
				method: action.method,
			})),
		[
			{
				id: "use-long-lived",
				render: "button",
				resultRender: "text",
				next: undefined,
				method: "dot.use-long-lived",
			},
		],
	);
	assert.deepEqual(
		fields
			.get("temporaryEndpoint")
			?.actions.map(({ id, render, resultRender, next, action }) => ({
				id,
				render,
				resultRender,
				next,
				method: action.method,
			})),
		[
			{
				id: "start-temporary",
				render: "button",
				resultRender: "text",
				next: undefined,
				method: "dot.start-temporary",
			},
		],
	);
	const subscription = fields.get("subscription");
	assert.equal(subscription?.label, "订阅消息");
	assert.match(subscription?.description ?? "", /Work/);
	assert.deepEqual(subscription?.actions.map(a => [a.id, a.render, a.resultRender, a.next]), [["show-instructions", "button", "text", undefined]]);
	const connectionActionIds =
		fields.get("connection")?.actions.map((action) => action.id) ?? [];
	assert.equal(connectionActionIds.includes("use-long-lived"), false);
	assert.equal(connectionActionIds.includes("start-temporary"), false);
	assert.equal(connectionActionIds.includes("show-instructions"), false);
});
