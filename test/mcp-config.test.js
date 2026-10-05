import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import kimiCuExtension from "../extensions/kimi-cu.js";
import { kimiCuServerDefinition } from "../src/constants.js";
import { detectKimiCuMcp, mergeMcpConfigValue, writeMcpConfig } from "../src/mcp-config.js";
import { formatKimiCuStatus } from "../src/status.js";

async function fixture(t) {
	const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	await mkdir(agentDir);
	await mkdir(path.join(cwd, ".pi"), { recursive: true });
	return {
		globalPath: path.join(agentDir, "mcp.json"),
		projectPath: path.join(cwd, ".pi", "mcp.json"),
		options: { cwd, env: { PI_CODING_AGENT_DIR: agentDir }, projectTrusted: true },
	};
}

const config = (entry = kimiCuServerDefinition()) => ({ mcpServers: { "kimi-cu": entry } });
const aliasConfig = { mcpServers: { kimi_cu: { command: "custom-server", enabled: false } } };
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value)}\n`);

for (const [name, value] of [
	["legacy root", { "mcp-servers": { other: { command: "other", disabled: true } } }],
	["legacy disabled", config({ ...kimiCuServerDefinition(), disabled: true })],
	["legacy disabled false", config({ ...kimiCuServerDefinition(), disabled: false })],
	["mixed legacy and native roots", { ...config(), "mcp-servers": { other: { command: "other", disabled: true } } }],
]) {
	test(`leaves ${name} bytes and permissions intact with manual instructions`, async (t) => {
		const { globalPath } = await fixture(t);
		const raw = `${JSON.stringify(value, null, 4)}\n`;
		await writeFile(globalPath, raw, { mode: 0o640 });
		await assert.rejects(writeMcpConfig(globalPath), (error) => {
			assert.match(error.message, /不自动迁移/);
			assert.match(error.message, /卸载 pi-mcp-adapter/);
			assert.match(error.message, /enabled:false/);
			return true;
		});
		assert.equal(await readFile(globalPath, "utf8"), raw);
		assert.equal((await stat(globalPath)).mode & 0o777, 0o640);
	});
}

test("refuses namespace collisions without modifying the target", async (t) => {
	const { globalPath } = await fixture(t);
	for (const servers of [
		aliasConfig.mcpServers,
		{ ...aliasConfig.mcpServers, ...config().mcpServers },
		{ ...config().mcpServers, ...aliasConfig.mcpServers },
	]) {
		const value = { mcpServers: servers };
		const original = structuredClone(value);
		assert.throws(() => mergeMcpConfigValue(value), /namespace conflict/);
		assert.deepEqual(value, original);
		await writeJson(globalPath, value);
		const raw = await readFile(globalPath, "utf8");
		await assert.rejects(writeMcpConfig(globalPath), /namespace conflict/);
		assert.equal(await readFile(globalPath, "utf8"), raw);
	}
});

test("checks namespace collisions in other active layers before writing", async (t) => {
	const { globalPath, projectPath } = await fixture(t);
	for (const [target, other] of [[projectPath, globalPath], [globalPath, projectPath]]) {
		await writeJson(other, aliasConfig);
		await rm(target, { force: true });
		await assert.rejects(writeMcpConfig(target, { otherConfigPaths: [other] }), /namespace conflict/);
		await assert.rejects(readFile(target), { code: "ENOENT" });
		assert.deepEqual(JSON.parse(await readFile(other, "utf8")), aliasConfig);
	}
});

test("refuses new project definitions over inherited settings without changing files", async (t) => {
	const { globalPath, projectPath } = await fixture(t);
	for (const settings of [
		{ enabled: false },
		{ exposure: "hidden" },
		{ toolExposure: { "*": "hidden" } },
		{ disabled: true },
		{ env: { PROFILE: "personal" }, args: ["mcp", "-s", "user"] },
	]) {
		await writeJson(globalPath, config({ ...kimiCuServerDefinition(), ...settings }));
		const globalRaw = await readFile(globalPath, "utf8");
		for (const existing of [false, true]) {
			if (existing) await writeFile(projectPath, '{ "mcpServers": { "other": { "command": "other" } } }\n', { mode: 0o640 });
			const before = existing ? await readFile(projectPath, "utf8") : undefined;
			await assert.rejects(writeMcpConfig(projectPath, {
				allowProjectOverride: true, otherConfigPaths: [globalPath, projectPath],
			}), /global MCP entry already exists.*\/mcp/);
			assert.equal(await readFile(globalPath, "utf8"), globalRaw);
			if (existing) {
				assert.equal(await readFile(projectPath, "utf8"), before);
				assert.equal((await stat(projectPath)).mode & 0o777, 0o640);
				await rm(projectPath);
			} else {
				await assert.rejects(readFile(projectPath), { code: "ENOENT" });
			}
		}
	}
});

test("refuses new project definitions when inherited configuration cannot be verified", async (t) => {
	const { globalPath, projectPath } = await fixture(t);
	for (const raw of ["{invalid", "null", "[]", '{"mcpServers":[]}', '{"mcpServers":null}']) {
		await writeFile(globalPath, raw);
		await assert.rejects(writeMcpConfig(projectPath, {
			allowProjectOverride: true, otherConfigPaths: [globalPath],
		}), /Cannot verify global MCP config/);
		await assert.rejects(readFile(projectPath), { code: "ENOENT" });
		assert.equal(await readFile(globalPath, "utf8"), raw);

		// An existing project entry is still a no-op, not a new override.
		await writeJson(projectPath, config());
		assert.equal((await writeMcpConfig(projectPath, {
			allowProjectOverride: true, otherConfigPaths: [globalPath],
		})).changed, false);
		await rm(projectPath);
	}
});

test("can still add a global entry when the other project layer is malformed", async (t) => {
	const { globalPath, projectPath } = await fixture(t);
	await writeFile(projectPath, "{invalid");
	assert.equal((await writeMcpConfig(globalPath, { otherConfigPaths: [projectPath] })).changed, true);
	assert.equal(await readFile(projectPath, "utf8"), "{invalid");
});

test("preserves existing project definitions and overrides even with a disabled global entry", async (t) => {
	const { globalPath, projectPath } = await fixture(t);
	await writeJson(globalPath, config({ ...kimiCuServerDefinition(), enabled: false }));
	for (const entry of [kimiCuServerDefinition(), { enabled: false }, { exposure: "direct" }]) {
		await writeJson(projectPath, config(entry));
		const raw = await readFile(projectPath, "utf8");
		const result = await writeMcpConfig(projectPath, {
			allowProjectOverride: true, otherConfigPaths: [globalPath],
		});
		assert.equal(result.changed, false);
		assert.equal(await readFile(projectPath, "utf8"), raw);
	}
});

test("reports same-file and cross-layer namespace conflicts, ignoring untrusted projects", async (t) => {
	const { globalPath, projectPath, options } = await fixture(t);
	for (const servers of [
		aliasConfig.mcpServers,
		{ ...aliasConfig.mcpServers, ...config().mcpServers },
		{ ...config().mcpServers, ...aliasConfig.mcpServers },
	]) {
		await writeJson(globalPath, { mcpServers: servers });
		const result = await detectKimiCuMcp(options);
		assert.equal(result.configured, false);
		assert.equal(result.conflict, true);
		assert.equal(result.conflictingServer, "kimi_cu");
	}
	await writeJson(globalPath, aliasConfig);
	await writeJson(projectPath, config());
	assert.equal((await detectKimiCuMcp(options)).conflict, true);
	await writeJson(globalPath, config());
	await writeJson(projectPath, aliasConfig);
	assert.equal((await detectKimiCuMcp(options)).conflict, true);
	assert.equal((await detectKimiCuMcp({ ...options, projectTrusted: false })).configured, true);
});

for (const [name, raw, diagnosticKey] of [
	["malformed JSON", "{invalid", "error"],
	["invalid root", "null", "error"],
	["invalid mcpServers", '{"mcpServers":[]}', "error"],
	["legacy root", JSON.stringify({ "mcp-servers": config().mcpServers }), "needsMigration"],
]) {
	test(`keeps valid trusted-project config despite global ${name}`, async (t) => {
		const { globalPath, projectPath, options } = await fixture(t);
		await writeFile(globalPath, raw);
		await writeJson(projectPath, config());
		const result = await detectKimiCuMcp(options);
		assert.equal(result.configured, true);
		assert.equal(result.configPath, projectPath);
		assert.equal(result.error, undefined);
		assert.equal(result.needsMigration, undefined);
		assert.equal(result.diagnostics[0].configPath, globalPath);
		assert.ok(result.diagnostics[0][diagnosticKey]);

		const untrusted = await detectKimiCuMcp({ ...options, projectTrusted: false });
		assert.equal(untrusted.configured, false);
		assert.ok(untrusted[diagnosticKey]);
		await writeJson(projectPath, config({ ...kimiCuServerDefinition(), enabled: false }));
		const disabled = await detectKimiCuMcp(options);
		assert.equal(disabled.disabled, true);
		assert.equal(disabled.configPath, projectPath);
	});
}

test("continues past an unreadable global layer without losing its diagnostic", async (t) => {
	const { globalPath, projectPath, options } = await fixture(t);
	await mkdir(globalPath);
	await writeJson(projectPath, config());
	const result = await detectKimiCuMcp(options);
	assert.equal(result.configured, true);
	assert.equal(result.configPath, projectPath);
	assert.ok(result.diagnostics[0].error);
});

test("keeps the global definition when a project file or override is invalid", async (t) => {
	const { globalPath, projectPath, options } = await fixture(t);
	await writeJson(globalPath, config({ ...kimiCuServerDefinition(), enabled: false }));
	for (const raw of ["{invalid", JSON.stringify(config({ enabled: "false" })), JSON.stringify(config({ env: {} }))]) {
		await writeFile(projectPath, raw);
		const result = await detectKimiCuMcp(options);
		assert.equal(result.configured, false);
		assert.equal(result.disabled, true);
		assert.equal(result.configPath, globalPath);
		assert.ok(result.diagnostics[0].error);
	}
});

test("skips malformed full project definitions while retaining the effective global config", async (t) => {
	const { globalPath, projectPath, options } = await fixture(t);
	for (const enabled of [true, false]) {
		await writeJson(globalPath, config({ ...kimiCuServerDefinition(), enabled }));
		for (const entry of [
			null, [], "invalid",
			...[
				{ enabled: "false" }, { exposure: "invalid" }, { toolExposure: { "*": false } },
				{ command: 42 }, { args: "mcp" }, { args: [42] }, { env: { KEY: false } },
				{ cwd: false }, { description: false }, { timeout: 0 }, { type: "sse" },
			].map((patch) => ({ ...kimiCuServerDefinition(), ...patch })),
		]) {
			await writeJson(projectPath, config(entry));
			const result = await detectKimiCuMcp(options);
			assert.equal(result.configured, enabled);
			assert.equal(result.disabled, enabled ? undefined : true);
			assert.equal(result.configPath, globalPath);
			assert.equal(result.conflict, undefined);
			assert.equal(result.diagnostics[0].configPath, projectPath);
			assert.match(result.diagnostics[0].error, /Invalid MCP server definition/);
		}
	}
});

test("skips invalid HTTP definitions and project-only credential restrictions", async (t) => {
	const { globalPath, projectPath, options } = await fixture(t);
	const invalidOAuth = [
		null, "invalid", { clientId: false }, { clientSecret: false }, { scope: false },
		{ callbackPort: 0 }, { callbackPort: 65536 }, { callbackPort: 1.5 },
		{ callbackUrl: "invalid" }, { callbackUrl: "https://localhost/callback" },
		{ callbackUrl: "http://example.com/callback" }, { callbackUrl: "http://localhost/callback?q=1" },
		{ callbackUrl: "http://localhost/callback#fragment" },
		{ callbackUrl: "http://localhost:8080/callback", callbackPort: 8081 },
		{ clientName: " " }, { clientRegistration: "unknown" },
		{ clientRegistration: "cimd", clientId: "client" },
		{ clientRegistration: "cimd", clientName: "client" },
		{ clientRegistration: "cimd", callbackUrl: "http://[::1]/callback" },
		{ clientRegistration: "cimd", callbackUrl: "http://localhost/wrong" },
		{ authServerMetadataUrl: "invalid" }, { authServerMetadataUrl: "http://example.com/metadata" },
	];
	const invalidEntries = [
		{ url: "invalid" }, { url: "file:///tmp/mcp" },
		{ url: "https://example.com/mcp", headers: { Authorization: false } },
		{ url: "https://example.com/mcp", auth: null },
		{ url: "https://example.com/mcp", auth: { provider: "" } },
		{ url: "http://example.com/mcp", auth: { provider: "anthropic" } },
		...invalidOAuth.map((oauth) => ({ url: "https://example.com/mcp", oauth })),
	];
	for (const entry of invalidEntries) {
		await writeJson(globalPath, config());
		await writeJson(projectPath, config(entry));
		const result = await detectKimiCuMcp(options);
		assert.equal(result.configured, true);
		assert.equal(result.configPath, globalPath);
		assert.ok(result.diagnostics[0].error);

		await writeJson(globalPath, config(entry));
		const standalone = await detectKimiCuMcp({ ...options, projectTrusted: false });
		assert.equal(standalone.configured, false);
		assert.ok(standalone.error);
		assert.equal(standalone.conflict, undefined);
	}
	await writeJson(globalPath, config());
	await writeJson(projectPath, config({ url: "https://example.com/mcp", auth: { provider: "anthropic" } }));
	const result = await detectKimiCuMcp(options);
	assert.equal(result.configured, true);
	assert.equal(result.configPath, globalPath);
	assert.ok(result.diagnostics[0].error);
});

test("valid HTTP OAuth definitions remain conflicts rather than exposing the global KimiCU server", async (t) => {
	const { globalPath, projectPath, options } = await fixture(t);
	await writeJson(globalPath, config());
	for (const oauth of [
		{}, { clientId: "client", clientSecret: "example", scope: "read", clientRegistration: "dcr" },
		{ callbackPort: 8080, callbackUrl: "http://localhost:8080/callback" },
		{ clientRegistration: "cimd", callbackUrl: "http://127.0.0.1/callback" },
		{ authServerMetadataUrl: "https://example.com/metadata" },
		{ authServerMetadataUrl: "http://[::1]/metadata" },
	]) {
		await writeJson(projectPath, config({ url: "https://example.com/mcp", oauth }));
		const result = await detectKimiCuMcp(options);
		assert.equal(result.configured, false);
		assert.equal(result.conflict, true);
		assert.equal(result.configPath, projectPath);
		assert.equal(result.diagnostics, undefined);
	}
});

test("accepts a positive infinite timeout like Pi instead of ignoring a custom server", async (t) => {
	const { globalPath, projectPath, options } = await fixture(t);
	await writeJson(globalPath, config());
	await writeFile(projectPath, '{"mcpServers":{"kimi-cu":{"command":"custom-server","timeout":1e999}}}');
	const result = await detectKimiCuMcp(options);
	assert.equal(result.configured, false);
	assert.equal(result.conflict, true);
	assert.equal(result.configPath, projectPath);
});

test("reports an invalid standalone definition instead of treating it as a custom server", async (t) => {
	const { globalPath, options } = await fixture(t);
	await writeJson(globalPath, config({ ...kimiCuServerDefinition(), enabled: "false" }));
	const result = await detectKimiCuMcp(options);
	assert.equal(result.configured, false);
	assert.equal(result.conflict, undefined);
	assert.ok(result.error);
});

test("valid custom project servers still replace the global KimiCU definition", async (t) => {
	const { globalPath, projectPath, options } = await fixture(t);
	await writeJson(globalPath, config());
	for (const entry of [
		{ command: "custom-server", args: ["--custom"], env: { KEY: "value" } },
		{ url: "https://example.com/mcp", headers: { Authorization: "Bearer example" } },
		{ ...kimiCuServerDefinition(), args: ["custom"] },
		{ ...kimiCuServerDefinition(), customOption: true },
	]) {
		await writeJson(projectPath, config(entry));
		const result = await detectKimiCuMcp(options);
		assert.equal(result.configured, false);
		assert.equal(result.conflict, true);
		assert.equal(result.configPath, projectPath);
		assert.equal(result.diagnostics, undefined);
	}
});

test("mcp command refuses legacy config, inherited settings and cross-layer conflicts without reloading", async (t) => {
	const { globalPath, projectPath, options } = await fixture(t);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = options.env.PI_CODING_AGENT_DIR;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	let command;
	const notifications = [];
	kimiCuExtension({
		registerMcpServer() {},
		registerCommand: (_name, definition) => { command = definition; },
		exec: async () => assert.fail("must not install or uninstall an adapter"),
	});
	const ctx = {
		cwd: options.cwd, hasUI: true, isProjectTrusted: () => true,
		ui: {
			select: async (_title, choices) => choices[1],
			notify: (message, severity) => notifications.push({ message, severity }),
			setStatus: () => undefined,
			confirm: async () => assert.fail("must not offer reload after a refused write"),
		},
		reload: async () => assert.fail("must not reload after a refused write"),
	};
	await writeJson(projectPath, { "mcp-servers": config().mcpServers });
	const raw = await readFile(projectPath, "utf8");
	await command.handler("mcp", ctx);
	assert.equal(await readFile(projectPath, "utf8"), raw);
	assert.equal(notifications.at(-1).severity, "error");
	assert.match(notifications.at(-1).message, /不自动迁移/);
	await rm(projectPath);
	await writeJson(globalPath, config({ ...kimiCuServerDefinition(), enabled: false }));
	await command.handler("mcp", ctx);
	assert.equal(notifications.at(-1).severity, "error");
	assert.match(notifications.at(-1).message, /global MCP entry already exists/);
	await assert.rejects(readFile(projectPath), { code: "ENOENT" });
	await writeJson(globalPath, aliasConfig);
	await command.handler("mcp", ctx);
	assert.equal(notifications.at(-1).severity, "error");
	assert.match(notifications.at(-1).message, /namespace conflict/);
	await assert.rejects(readFile(projectPath), { code: "ENOENT" });
});

test("displays file diagnostics without hiding the effective config", async (t) => {
	const { globalPath, projectPath, options } = await fixture(t);
	await writeJson(globalPath, { "mcp-servers": config().mcpServers });
	await writeJson(projectPath, config());
	const mcp = await detectKimiCuMcp(options);
	const output = formatKimiCuStatus({
		ready: true, supported: true, platform: "darwin", arch: "arm64",
		app: { installed: true }, service: { running: true }, permissions: { granted: true }, mcp,
	});
	assert.ok(output.includes(projectPath));
	assert.ok(output.includes(globalPath));
	assert.match(output, /Config warning/);
	assert.match(output, /不自动迁移/);
});
