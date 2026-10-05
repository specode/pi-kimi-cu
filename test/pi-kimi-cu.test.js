import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmod,
	mkdtemp,
	mkdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import kimiCuExtension from "../extensions/kimi-cu.js";
import { DEFAULT_APP_PATH, appBinary } from "../src/constants.js";
import {
	detectKimiCuMcp,
	isKnownKimiCuEntry,
	mergeMcpConfigValue,
	writeMcpConfig,
} from "../src/mcp-config.js";
import {
	buildReplacementScript,
	downloadFile,
	installKimiCuApp,
	openKimiCuApp,
	shellQuote,
} from "../src/installer.js";
import {
	detectKimiCu,
	isSupportedMacVersion,
	parsePermissionStatus,
	parseServiceRunning,
} from "../src/status.js";

function execResult({
	stdout = "",
	stderr = "",
	code = 0,
	killed = false,
} = {}) {
	return { stdout, stderr, code, killed };
}

function downloadResponse(bytes = Buffer.from("zip")) {
	return {
		ok: true,
		status: 200,
		headers: {
			get: (name) =>
				name === "content-length" ? String(bytes.byteLength) : null,
		},
		body: {
			async *[Symbol.asyncIterator]() {
				yield bytes;
			},
		},
	};
}

async function createStagedApp(unzipDir) {
	const stagedApp = path.join(unzipDir, "KimiCU.app");
	const binary = appBinary(stagedApp);
	await mkdir(path.dirname(binary), { recursive: true });
	await writeFile(binary, "binary");
	await chmod(binary, 0o755);
	await writeFile(
		path.join(stagedApp, "Contents", "Info.plist"),
		[
			"<plist><dict>",
			"<key>CFBundleIdentifier</key><string>ai.kimi.cu</string>",
			"<key>CFBundleShortVersionString</key><string>1.0</string>",
			"<key>LSMinimumSystemVersion</key><string>14.0</string>",
			"</dict></plist>",
		].join(""),
	);
}

test("parses KimiCU service and permission probes", () => {
	assert.equal(parseServiceRunning("SMAppService status=1 (enabled)"), true);
	assert.equal(parseServiceRunning("SMAppService status=3 (notFound)"), false);
	assert.deepEqual(
		parsePermissionStatus(
			"permissionStatus: accessibility=true screenRecording=false",
		),
		{ accessibility: true, screenRecording: false },
	);
	assert.equal(isSupportedMacVersion("14.0"), true);
	assert.equal(isSupportedMacVersion("13.6.9"), false);
});

test("opens KimiCU.app for permission handoff", async () => {
	const calls = [];
	const exec = async (command, args) => {
		calls.push([command, ...args]);
		if (command === "open") return execResult();
		throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
	};

	const result = await openKimiCuApp({
		exec,
		appPath: "/Applications/KimiCU.app",
	});
	assert.deepEqual(result, { opened: true, detail: undefined });
	assert.deepEqual(calls, [["open", "-a", "/Applications/KimiCU.app"]]);
});

test("merges KimiCU without changing unrelated MCP servers", () => {
	const original = {
		settings: { hostConfigDiscovery: "off" },
		mcpServers: { docs: { command: "docs-mcp", args: [] } },
	};
	const merged = mergeMcpConfigValue(original);
	assert.equal(merged.changed, true);
	assert.deepEqual(merged.value.mcpServers.docs, original.mcpServers.docs);
	assert.deepEqual(merged.value.mcpServers["kimi-cu"], {
		command: appBinary(),
		args: ["mcp"],
	});
});

test("refuses legacy mcp-servers instead of migrating unrelated servers", () => {
	const value = {
		"mcp-servers": {
			docs: { command: "docs-mcp", args: [] },
			legacy: { command: "legacy-mcp", args: [], disabled: true },
		},
		mcpServers: {
			docs: { command: "new-docs-mcp", args: [] },
			search: { command: "search-mcp", args: [] },
		},
	};
	const original = structuredClone(value);
	assert.throws(() => mergeMcpConfigValue(value), /不自动迁移/);
	assert.deepEqual(value, original);
});

test("preserves recognized KimiCU arguments without migrating them", () => {
	const legacy = {
		command: appBinary(),
		args: ["mcp", "-s", "user"],
	};
	assert.equal(isKnownKimiCuEntry(legacy), true);
	const merged = mergeMcpConfigValue({ mcpServers: { "kimi-cu": legacy } });
	assert.equal(merged.changed, false);
	assert.deepEqual(merged.value.mcpServers["kimi-cu"], legacy);

	assert.throws(
		() =>
			mergeMcpConfigValue({
				mcpServers: {
					"kimi-cu": { command: "/custom/server", args: ["serve"] },
				},
			}),
		/已存在/,
	);
});

test("writes MCP configuration atomically and preserves existing mode", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-test-"));
	try {
		const configPath = path.join(root, "nested", "mcp.json");
		await mkdir(path.dirname(configPath), { recursive: true });
		await writeFile(
			configPath,
			'{"mcpServers":{"docs":{"command":"docs"}}}\n',
			{ mode: 0o640 },
		);
		const result = await writeMcpConfig(configPath);
		assert.equal(result.changed, true);
		const value = JSON.parse(await readFile(configPath, "utf8"));
		assert.equal(value.mcpServers.docs.command, "docs");
		assert.deepEqual(value.mcpServers["kimi-cu"].args, ["mcp"]);
		assert.equal((await stat(configPath)).mode & 0o777, 0o640);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("refuses malformed MCP JSON without replacing it", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-invalid-"));
	try {
		const configPath = path.join(root, "mcp.json");
		await writeFile(configPath, "{ invalid json\n");
		await assert.rejects(writeMcpConfig(configPath), /不是有效 JSON/);
		assert.equal(await readFile(configPath, "utf8"), "{ invalid json\n");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("uses the highest-precedence KimiCU MCP definition", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-precedence-"));
	try {
		const home = path.join(root, "home");
		const cwd = path.join(root, "project");
		const agentDir = path.join(home, ".pi", "agent");
		await mkdir(agentDir, { recursive: true });
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: { "kimi-cu": { command: appBinary(), args: ["mcp"] } },
			}),
		);
		await writeFile(
			path.join(cwd, ".pi", "mcp.json"),
			JSON.stringify({
				mcpServers: { "kimi-cu": { command: "/custom/kimi-cu", args: [] } },
			}),
		);
		const result = await detectKimiCuMcp({ cwd, home, env: {}, projectTrusted: true });
		assert.equal(result.configured, false);
		assert.equal(result.conflict, true);
		assert.equal(result.configPath, path.join(cwd, ".pi", "mcp.json"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("honors native disabled state and trusted project overrides", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-native-"));
	try {
		const home = path.join(root, "home"), cwd = path.join(root, "project");
		const agentDir = path.join(home, ".pi", "agent");
		await mkdir(agentDir, { recursive: true });
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(path.join(agentDir, "mcp.json"), JSON.stringify({
			mcpServers: { "kimi-cu": { command: appBinary(), args: ["mcp"], exposure: "direct" } },
		}));
		const projectPath = path.join(cwd, ".pi", "mcp.json");
		await writeFile(projectPath, JSON.stringify({ mcpServers: { "kimi-cu": { enabled: false } } }));
		assert.equal((await detectKimiCuMcp({ cwd, home, env: {} })).configured, true);
		assert.deepEqual(await detectKimiCuMcp({ cwd, home, env: {}, projectTrusted: true }), {
			configured: false, configPath: projectPath, disabled: true,
		});
		await writeFile(projectPath, JSON.stringify({ mcpServers: { "kimi-cu": { exposure: "codemode" } } }));
		assert.equal((await detectKimiCuMcp({ cwd, home, env: {}, projectTrusted: true })).configured, true);
		// A full project entry replaces, rather than merges with, the global entry.
		await writeFile(projectPath, JSON.stringify({ mcpServers: { "kimi-cu": { command: appBinary() } } }));
		assert.equal((await detectKimiCuMcp({ cwd, home, env: {}, projectTrusted: true })).conflict, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("preserves native settings and refuses legacy disabled entries", () => {
	const native = {
		command: appBinary(), args: ["mcp"], enabled: false, exposure: "direct",
		toolExposure: { get_app_state: "codemode" }, description: "Desktop",
		env: { EXAMPLE: "value" }, cwd: "/tmp", timeout: 30, type: "stdio",
	};
	const merged = mergeMcpConfigValue({ mcpServers: { "kimi-cu": native } });
	assert.equal(merged.changed, false);
	assert.deepEqual(merged.value.mcpServers["kimi-cu"], native);
	assert.equal(isKnownKimiCuEntry(native), false);
	for (const disabled of [true, false]) {
		assert.throws(() => mergeMcpConfigValue({ mcpServers: {
			"kimi-cu": { command: appBinary(), args: ["mcp", "-s", "user"], disabled },
		} }), /不自动迁移/);
	}
	assert.throws(() => mergeMcpConfigValue({ mcpServers: {
		"kimi-cu": { ...native, socket: "/custom" },
	} }), /已存在/);
});

test("ignores adapter-only config paths and reports invalid or legacy native files", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-native-paths-"));
	try {
		const home = path.join(root, "home"), cwd = path.join(root, "project");
		const agentDir = path.join(home, ".pi", "agent");
		const value = { mcpServers: { "kimi-cu": { command: appBinary(), args: ["mcp"] } } };
		for (const file of [
			path.join(home, ".config", "mcp", "mcp.json"),
			path.join(home, ".agents", "mcp.json"),
			path.join(home, ".agents", "mcp", "mcp.json"),
			path.join(cwd, ".mcp.json"),
		]) {
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, JSON.stringify(value));
		}
		assert.deepEqual(await detectKimiCuMcp({ cwd, home, env: {} }), { configured: false });
		await mkdir(agentDir, { recursive: true });
		const file = path.join(agentDir, "mcp.json");
		await writeFile(file, "{invalid");
		assert.ok((await detectKimiCuMcp({ cwd, home, env: {} })).error);
		await writeFile(file, JSON.stringify({ "mcp-servers": value.mcpServers }));
		assert.equal((await detectKimiCuMcp({ cwd, home, env: {} })).needsMigration, true);
		await writeFile(file, JSON.stringify({ mcpServers: {
			"kimi-cu": { ...value.mcpServers["kimi-cu"], disabled: true },
		} }));
		assert.equal((await detectKimiCuMcp({ cwd, home, env: {} })).needsMigration, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("aborts a download whose response body stops transferring", async () => {
	const root = await mkdtemp(
		path.join(tmpdir(), "pi-kimi-cu-download-timeout-"),
	);
	try {
		const destination = path.join(root, "archive.zip");
		const fetchImpl = async (_url, { signal }) => ({
			ok: true,
			status: 200,
			headers: { get: () => null },
			body: {
				async *[Symbol.asyncIterator]() {
					yield Buffer.from("partial");
					await new Promise((resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), {
							once: true,
						});
					});
				},
			},
		});

		await assert.rejects(
			downloadFile(
				"https://example.invalid/archive.zip",
				destination,
				fetchImpl,
				undefined,
				20,
			),
			/下载超时/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("treats a killed strict codesign verification as invalid", async () => {
	const root = await mkdtemp(
		path.join(tmpdir(), "pi-kimi-cu-codesign-timeout-"),
	);
	try {
		let approvalDetail;
		const exec = async (command, args) => {
			if (command === "ditto") {
				await createStagedApp(args[3]);
				return execResult();
			}
			if (command === "lipo") return execResult({ stdout: "arm64" });
			if (command === "codesign" && args[0] === "-dv") {
				return execResult({ stderr: "TeamIdentifier=2J9472RW75" });
			}
			if (command === "codesign") {
				return execResult({ code: 0, killed: true });
			}
			throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
		};

		await assert.rejects(
			installKimiCuApp({
				exec,
				fetchImpl: async () => downloadResponse(),
				appPath: path.join(root, "Applications", "KimiCU.app"),
				tempBase: root,
				approveInvalidSignature: async (detail) => {
					approvalDetail = detail;
					return false;
				},
			}),
			/代码签名验证失败/,
		);
		assert.match(approvalDetail, /被终止/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("restores the old background service when app replacement fails", async () => {
	const root = await mkdtemp(
		path.join(tmpdir(), "pi-kimi-cu-service-rollback-"),
	);
	try {
		const appPath = path.join(root, "Applications", "KimiCU.app");
		await createStagedApp(path.dirname(appPath));
		let restored = 0;
		const exec = async (command, args) => {
			if (command === "ditto") {
				await createStagedApp(args[3]);
				return execResult();
			}
			if (command === "lipo") return execResult({ stdout: "arm64" });
			if (command === "codesign" && args[0] === "-dv") {
				return execResult({ stderr: "TeamIdentifier=2J9472RW75" });
			}
			if (command === "codesign") return execResult();
			if (command === "/bin/sh")
				return execResult({ code: 1, stderr: "permission denied" });
			if (command === "osascript")
				return execResult({ code: 1, stderr: "User canceled" });
			if (command === appBinary(appPath) && args[0] === "install") {
				restored += 1;
				return execResult();
			}
			if (command === appBinary(appPath) && args[0] === "service-status") {
				return execResult({ stdout: "status=1" });
			}
			return execResult();
		};

		await assert.rejects(
			installKimiCuApp({
				exec,
				fetchImpl: async () => downloadResponse(),
				appPath,
				tempBase: root,
				sleep: async () => undefined,
			}),
			/无法安装/,
		);
		assert.equal(restored, 1);
		assert.equal(await readFile(appBinary(appPath), "utf8"), "binary");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("replacement script quotes generated paths and includes rollback", () => {
	assert.equal(shellQuote("/tmp/a'b"), "'/tmp/a'\\''b'");
	const script = buildReplacementScript(
		"/tmp/kimi cu/KimiCU.app",
		DEFAULT_APP_PATH,
		"test",
	);
	assert.match(script, /\/usr\/bin\/ditto '\/tmp\/kimi cu\/KimiCU\.app'/);
	assert.match(script, /backup-test/);
	assert.match(script, /\/bin\/mv/);
	assert.doesNotMatch(script, /\n/);
	const syntax = spawnSync("/bin/sh", ["-n", "-c", script], {
		encoding: "utf8",
	});
	assert.equal(syntax.status, 0, syntax.stderr);
});

test("replacement script installs the staged app and removes its backup", {
	skip: process.platform !== "darwin" ? "requires macOS /usr/bin/ditto" : false,
}, async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-replace-"));
	try {
		const source = path.join(root, "source", "KimiCU.app");
		const target = path.join(root, "Applications", "KimiCU.app");
		await mkdir(source, { recursive: true });
		await mkdir(target, { recursive: true });
		await writeFile(path.join(source, "version"), "new");
		await writeFile(path.join(target, "version"), "old");
		const script = buildReplacementScript(source, target, "integration");
		const result = spawnSync("/bin/sh", ["-c", script], {
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(await readFile(path.join(target, "version"), "utf8"), "new");
		await assert.rejects(
			readFile(
				path.join(
					root,
					"Applications",
					".KimiCU.app.backup-integration",
					"version",
				),
			),
			/ENOENT/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("accepts an Apple Silicon host when Pi runs as x64 under Rosetta", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-rosetta-"));
	try {
		const exec = async (command, args) => {
			if (command === "sw_vers") return execResult({ stdout: "14.6\n" });
			if (command === "sysctl" && args[1] === "hw.optional.arm64") {
				return execResult({ stdout: "1\n" });
			}
			if (command === "sysctl") return execResult({ code: 1 });
			throw new Error(`unexpected command: ${command}`);
		};

		const result = await detectKimiCu({
			exec,
			cwd: path.join(root, "project"),
			home: path.join(root, "home"),
			env: {},
			appPath: path.join(root, "Applications", "KimiCU.app"),
			platform: "darwin",
			arch: "x64",
		});
		assert.equal(result.hostArm64, true);
		assert.equal(result.supported, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("writes trusted project config and never touches a stale context after reload", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-cu-reload-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
		const cwd = path.join(root, "project");
		let command;
		let stale = false;
		const assertActive = () => assert.equal(stale, false, "stale context");
		kimiCuExtension({
			registerMcpServer() {},
			registerCommand: (_name, definition) => { command = definition; },
			exec: async () => { throw new Error("must not install an adapter"); },
		});
		const ctx = {
			cwd, hasUI: true, isProjectTrusted: () => true,
			ui: {
				select: async (_title, choices) => {
					assertActive();
					assert.equal(choices.length, 3);
					return choices[1];
				},
				confirm: async () => { assertActive(); return true; },
				notify: () => assertActive(),
				setStatus: () => assertActive(),
			},
			reload: async () => { assertActive(); stale = true; },
		};
		await command.handler("mcp", ctx);
		assert.equal(stale, true);
		const value = JSON.parse(await readFile(path.join(cwd, ".pi", "mcp.json"), "utf8"));
		assert.deepEqual(value.mcpServers["kimi-cu"], { command: appBinary(), args: ["mcp"] });
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});

test("old Pi is directed to the legacy plugin without making changes", async () => {
	let command;
	const notifications = [];
	kimiCuExtension({ registerCommand: (_name, definition) => { command = definition; } });
	await command.handler("setup", { ui: { notify: (message) => notifications.push(message) } });
	assert.equal(notifications.length, 1);
	assert.match(notifications[0], /Pi >=0.99.0/);
	assert.match(notifications[0], /pi-kimi-cu@1.0.0/);
});

test("untrusted projects are not offered a project config write", async () => {
	let command;
	kimiCuExtension({
		registerMcpServer() {},
		registerCommand: (_name, definition) => { command = definition; },
	});
	await command.handler("mcp", {
		cwd: "/unused", hasUI: true, isProjectTrusted: () => false,
		ui: {
			notify: () => undefined,
			select: async (_title, choices) => {
				assert.equal(choices.length, 2);
				assert.doesNotMatch(choices.join(" "), /Current trusted project|adapter|Custom/);
				return undefined;
			},
		},
	});
});
