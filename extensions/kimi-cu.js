import {
	MCP_MIGRATION_GUIDANCE,
	mcpConfigPaths,
	mcpConfigSnippet,
	writeMcpConfig,
} from "../src/mcp-config.js";
import {
	ensureKimiCuService,
	installKimiCuApp,
	openKimiCuApp,
} from "../src/installer.js";
import { detectKimiCu, formatKimiCuStatus } from "../src/status.js";

const MENU = {
	status: "检查状态 / Check status",
	setup: "引导配置 / Guided setup",
};

function extensionExec(pi) {
	return async (command, args, options) => {
		const result = await pi.exec(command, args, options);
		if (result?.killed !== true) return result;
		return {
			...result,
			code: result.code === 0 ? -1 : result.code,
			stderr:
				result.stderr ||
				"命令被终止（可能超时） / Command terminated (possible timeout)",
		};
	};
}

function requireUi(ctx, action) {
	if (ctx.hasUI) return true;
	ctx.ui.notify(
		`${action} 需要交互式 Pi 会话 / requires an interactive Pi session`,
		"error",
	);
	return false;
}

function operationLabel(step, percent) {
	if (step === "download") {
		return `下载 KimiCU / Downloading KimiCU${typeof percent === "number" ? ` ${percent}%` : ""}`;
	}
	if (step === "unpack")
		return "解压并验证 KimiCU / Unpacking and verifying KimiCU";
	if (step === "replace") return "安装 KimiCU.app / Installing KimiCU.app";
	return "处理 KimiCU / Working on KimiCU";
}

async function detect(pi, ctx) {
	return detectKimiCu({
		exec: extensionExec(pi),
		cwd: ctx.cwd,
		projectTrusted: ctx.isProjectTrusted(),
	});
}

async function showStatus(pi, ctx) {
	const status = await detect(pi, ctx);
	ctx.ui.notify(
		formatKimiCuStatus(status),
		status.ready ? "info" : "warning",
	);
	return status;
}

async function maybeReload(ctx, lifecycle) {
	if (!ctx.hasUI) return false;
	if (
		await ctx.ui.confirm(
			"重新加载 Pi / Reload Pi",
			"现在重新加载 Pi 并连接内置 MCP？ / Reload Pi and connect its built-in MCP now?",
		)
	) {
		ctx.ui.setStatus("kimi-cu", undefined);
		lifecycle.reloading = true;
		await ctx.reload();
		return true;
	}
	ctx.ui.notify(
		"请稍后运行 /reload 使 MCP 配置生效 / Run /reload later for the MCP config to take effect",
		"info",
	);
	return false;
}

async function configureMcp(ctx, lifecycle, { interactive = true } = {}) {
	if (!requireUi(ctx, "配置 MCP / Configure MCP")) return;
	ctx.ui.notify(MCP_MIGRATION_GUIDANCE, "info");
	const paths = mcpConfigPaths({ cwd: ctx.cwd });
	let configPath = paths.piGlobal;
	if (interactive) {
		const globalChoice = "Pi 全局配置 / Pi global config";
		const projectChoice = "当前可信项目 / Current trusted project";
		const manualChoice = "只显示配置片段 / Show config snippet only";
		const choices = [globalChoice];
		if (ctx.isProjectTrusted()) choices.push(projectChoice);
		choices.push(manualChoice);
		const choice = await ctx.ui.select("KimiCU 内置 MCP / Built-in MCP", choices);
		if (!choice) return;
		if (choice === manualChoice) {
			await ctx.ui.editor("KimiCU MCP config", mcpConfigSnippet());
			return { reloaded: false };
		}
		if (choice === projectChoice) {
			if (!ctx.isProjectTrusted()) return;
			configPath = paths.projectPi;
		}
	}
	const result = await writeMcpConfig(configPath, {
		allowProjectOverride: configPath === paths.projectPi,
		otherConfigPaths: [paths.piGlobal, ...(ctx.isProjectTrusted() ? [paths.projectPi] : [])],
	});
	ctx.ui.notify(
		result.changed
			? `已更新 MCP 配置 / Updated MCP config：${result.configPath}`
			: `MCP 配置未改变 / MCP config unchanged：${result.configPath}`,
		"info",
	);
	ctx.ui.notify(
		"连接、启用状态及工具暴露方式请在 /mcp 中检查。已禁用的配置不会被自动启用。 / Check connection, enabled state and exposure in /mcp. Disabled entries are not automatically enabled.",
		"info",
	);
	return { reloaded: await maybeReload(ctx, lifecycle) };
}

async function runSetupGuide(pi, ctx, lifecycle) {
	if (!requireUi(ctx, "引导配置 / Guided setup")) return;

	const exec = extensionExec(pi);
	let status = await detect(pi, ctx);

	if (!status.supported) {
		ctx.ui.notify(
			"KimiCU 当前只支持 Apple Silicon Mac，且官方 App 要求 macOS 14 或更高版本 / KimiCU currently requires Apple Silicon Mac and macOS 14+",
			"error",
		);
		return;
	}

	try {
		// 1) App
		if (!status.app.installed) {
			const approved = await ctx.ui.confirm(
				"安装 KimiCU / Install KimiCU",
				"未检测到 /Applications/KimiCU.app。从官方 CDN 下载并安装？ / KimiCU.app not found. Download from the official CDN and install?",
			);
			if (!approved) {
				ctx.ui.notify(
					"已跳过安装。装好 App 后可再运行 /kimi-cu setup / Install skipped. Run /kimi-cu setup again after installing the app",
					"info",
				);
				return;
			}
			await installKimiCuApp({
				exec,
				onProgress: (step, percent) =>
					ctx.ui.setStatus("kimi-cu", operationLabel(step, percent)),
				approveInvalidSignature: (detail) =>
					ctx.ui.confirm(
						"KimiCU 签名验证失败 / Signature verification failed",
						`codesign 未通过 / codesign failed：${detail || "无详细信息 / no details"}\n\n继续安装会绕过本扩展的完整性保护。是否仍然继续？ / Continuing bypasses this extension's integrity checks. Continue anyway?`,
					),
			});
			status = await detect(pi, ctx);
		}

		// 2) Background service / app runtime
		if (!status.service.running) {
			const approved = await ctx.ui.confirm(
				"启动 KimiCU 后台服务 / Start KimiCU background service",
				"KimiCU 已安装，但后台服务未运行。现在注册并启动？ / KimiCU is installed but the background service is not running. Register and start it now?",
			);
			if (!approved) {
				ctx.ui.notify(
					"后台服务未启动，后续权限与 MCP 可能不可用 / Background service not started; permissions and MCP may be unavailable",
					"warning",
				);
			} else {
				ctx.ui.setStatus(
					"kimi-cu",
					"注册 KimiCU 后台服务 / Registering KimiCU background service",
				);
				await ensureKimiCuService({ exec });
				status = await detect(pi, ctx);
			}
		}

		// 3) Permissions — hand off to the official app UI
		if (status.app.installed && !status.permissions.granted) {
			ctx.ui.setStatus("kimi-cu", "打开 KimiCU / Opening KimiCU");
			const opened = await openKimiCuApp({ exec });
			ctx.ui.setStatus("kimi-cu", undefined);
			await ctx.ui.confirm(
				"在 KimiCU 中确认权限 / Confirm permissions in KimiCU",
				`${opened.opened ? "已打开 KimiCU。/ Opened KimiCU. " : "请手动打开 KimiCU。/ Please open KimiCU manually. "}在 App 窗口里把 Accessibility 和 Screen Recording 都设为 Allowed，完成后点继续。/ In the app window, set Accessibility and Screen Recording to Allowed, then continue.`,
			);
			status = await detect(pi, ctx);
			if (!status.permissions.granted) {
				ctx.ui.notify(
					"权限仍未就绪。请在 KimiCU App 中处理，然后可再运行 /kimi-cu setup 或 /kimi-cu status / Permissions still missing. Fix them in the KimiCU app, then run /kimi-cu setup or /kimi-cu status again",
					"warning",
				);
			}
		}

		// 4) MCP config
		if (!status.mcp.configured) {
			if (status.mcp.needsMigration) {
				ctx.ui.notify(MCP_MIGRATION_GUIDANCE, "warning");
			} else if (status.mcp.disabled || status.mcp.error) {
				ctx.ui.notify(
					"MCP 已禁用或配置无效，请先在 /mcp 中检查。 / MCP is disabled or its config is invalid; check /mcp first.",
					"warning",
				);
			} else if (status.mcp.conflict) {
				ctx.ui.notify(
					`MCP 配置存在同名冲突 / MCP config name conflict（${status.mcp.configPath || "未知路径 / unknown path"}），请手动检查后重试 / please inspect manually and retry`,
					"error",
				);
			} else {
				const approved = await ctx.ui.confirm(
					"配置 MCP / Configure MCP",
					"尚未配置 kimi-cu MCP。现在写入默认 Pi MCP 配置？ / kimi-cu MCP is not configured. Write the default Pi MCP config now?",
				);
				if (approved) {
					const configured = await configureMcp(ctx, lifecycle, {
						interactive: false,
					});
					if (configured?.reloaded) return;
					status = await detect(pi, ctx);
				} else {
					ctx.ui.notify(
						"已跳过 MCP 配置。需要时可再运行 /kimi-cu setup / MCP config skipped. Run /kimi-cu setup again when needed",
						"info",
					);
				}
			}
		}

		// Pi owns connection state. Do not infer it from an adapter event or
		// registered tools (which may remain registered after disconnection).
		if (status.ready) {
			ctx.ui.notify(
				"本地环境和配置已就绪；请在 /mcp 中确认 kimi-cu 已连接。 / Local setup is ready; confirm kimi-cu is connected in /mcp.",
				"info",
			);
		}
		await showStatus(pi, ctx);
	} finally {
		if (!lifecycle.reloading) ctx.ui.setStatus("kimi-cu", undefined);
	}
}

async function dispatch(pi, args, ctx, lifecycle) {
	const command = args.trim().split(/\s+/)[0]?.toLowerCase() || "menu";
	if (command === "status") return showStatus(pi, ctx);
	if (
		command === "setup" ||
		command === "install" ||
		command === "repair" ||
		command === "update"
	) {
		return runSetupGuide(pi, ctx, lifecycle);
	}
	if (command === "mcp")
		return configureMcp(ctx, lifecycle, { interactive: true });
	if (command !== "menu" && command !== "help") {
		ctx.ui.notify("用法 / Usage：/kimi-cu [status|setup|mcp]", "warning");
		return;
	}
	if (!requireUi(ctx, "KimiCU 菜单 / menu")) return;

	const selected = await ctx.ui.select(
		"Kimi Computer Use",
		Object.values(MENU),
	);
	if (!selected) return;
	const selectedCommand = Object.entries(MENU).find(
		([, label]) => label === selected,
	)?.[0];
	if (selectedCommand)
		return dispatch(pi, selectedCommand, ctx, lifecycle);
}

export default function kimiCuExtension(pi) {
	pi.registerCommand("kimi-cu", {
		description:
			"检查状态或引导配置 Kimi Computer Use / Check status or guided setup for Kimi Computer Use",
		getArgumentCompletions: (prefix) => {
			const values = ["status", "setup", "mcp"];
			const matches = values.filter((value) => value.startsWith(prefix));
			return matches.length > 0
				? matches.map((value) => ({ value, label: value }))
				: null;
		},
		handler: async (args, ctx) => {
			if (typeof pi.registerMcpServer !== "function") {
				ctx.ui.notify(
					"需要 Pi >=0.99.0 的内置 MCP。旧版 Pi 请安装：pi install npm:@specode/pi-kimi-cu@1.0.0 / Requires Pi >=0.99.0 with built-in MCP. On older Pi, pin pi-kimi-cu@1.0.0.",
					"error",
				);
				return;
			}
			const lifecycle = { reloading: false };
			try {
				await dispatch(pi, args, ctx, lifecycle);
			} catch (error) {
				if (lifecycle.reloading) return;
				ctx.ui.setStatus("kimi-cu", undefined);
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});
}
