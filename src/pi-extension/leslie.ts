/**
 * LESLIE ↔ pi bridge extension.
 *
 * Loaded by LESLIE with `pi --mode rpc --extension <this file>`. It registers
 * LESLIE's desktop tools as pi tools that call back into the Electron main
 * process over a local socket, injects LESLIE's persona/memory into the system
 * prompt, applies LESLIE's chat/plan/agent tool selection, and gates shell and
 * file writes through LESLIE's approval UI (or plan mode's read-only rules).
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HELPER_MAX_TOKENS = 4096;

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; onProgress?: (text: string) => void };

function createBridgeClient(address: string) {
	let socket: net.Socket | null = null;
	let connecting: Promise<net.Socket> | null = null;
	const pending = new Map<number, Pending>();
	let seq = 0;

	const failAll = (reason: string) => {
		for (const p of pending.values()) p.reject(new Error(reason));
		pending.clear();
	};

	const connect = () => {
		if (socket && !socket.destroyed) return Promise.resolve(socket);
		if (connecting) return connecting;
		connecting = new Promise<net.Socket>((resolve, reject) => {
			const s = net.createConnection(address);
			let buffer = "";
			s.setEncoding("utf8");
			s.once("connect", () => {
				socket = s;
				connecting = null;
				resolve(s);
			});
			s.once("error", (err) => {
				connecting = null;
				reject(err);
			});
			s.on("close", () => {
				socket = null;
				failAll("LESLIE bridge disconnected");
			});
			s.on("data", (chunk: string) => {
				buffer += chunk;
				let nl: number;
				while ((nl = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 1);
					let msg: any;
					try {
						msg = JSON.parse(line);
					} catch {
						continue;
					}
					const p = pending.get(msg.id);
					if (!p) continue;
					if (msg.progress !== undefined) {
						p.onProgress?.(msg.progress);
						continue;
					}
					pending.delete(msg.id);
					if (msg.error) p.reject(new Error(msg.error));
					else p.resolve(msg.result);
				}
			});
		});
		return connecting;
	};

	return async function call(method: string, params: object = {}, onProgress?: (text: string) => void): Promise<any> {
		const s = await connect();
		const id = ++seq;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject, onProgress });
			s.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	};
}

export default function (pi: ExtensionAPI) {
	const manifestPath = process.env.LESLIE_PI_MANIFEST;
	const bridgeAddress = process.env.LESLIE_BRIDGE;
	if (!manifestPath || !bridgeAddress) return;

	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const bridgeCall = createBridgeClient(bridgeAddress);
	// Set when LESLIE runs this pi as a helper; the bridge then applies the helper's rules.
	const helper = process.env.LESLIE_HELPER;
	const call: typeof bridgeCall = (method, params = {}, onProgress) =>
		bridgeCall(method, helper ? { ...params, helper } : params, onProgress);

	if (manifest.provider) pi.registerProvider("leslie", manifest.provider);

	for (const spec of manifest.tools) {
		pi.registerTool({
			name: spec.name,
			label: spec.name,
			description: spec.description,
			parameters: Type.Unsafe(spec.parameters),
			async execute(toolCallId, params, signal, onUpdate) {
				const onAbort = () => call("cancel", { callId: toolCallId }).catch(() => {});
				signal?.addEventListener("abort", onAbort, { once: true });
				try {
					const { output, images } = await call("tool", { callId: toolCallId, name: spec.name, args: params }, (text) =>
						onUpdate?.({ content: [{ type: "text", text }], details: undefined }),
					);
					const pictures = (images ?? []).map((img: { data: string; mimeType: string }) => ({
						type: "image" as const,
						data: img.data,
						mimeType: img.mimeType,
					}));
					return { content: [{ type: "text", text: output }, ...pictures], details: undefined };
				} finally {
					signal?.removeEventListener("abort", onAbort);
				}
			},
		});
	}

	// LESLIE's server manager loads models behind pi's back; re-read the llama.cpp
	// catalog so the newly loaded model can be selected.
	pi.registerCommand("leslie-sync-models", {
		description: "Internal: refresh the llama.cpp model list for LESLIE",
		handler: async (_args, ctx) => {
			const result = await ctx.modelRegistry.refresh({ providers: ["llama.cpp"], allowNetwork: true, signal: AbortSignal.timeout(15_000) });
			const error = result.errors?.get?.("llama.cpp");
			if (error) throw error;
		},
	});

	pi.on("before_agent_start", async (event) => {
		const { sections, activeTools, managedTools } = await call("context");
		const managed = new Set<string>(managedTools);
		const kept = pi.getActiveTools().filter((name) => !managed.has(name));
		pi.setActiveTools([...kept, ...activeTools]);
		event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, ...sections };
	});

	// A helper may only act through tools, so the one way to finish is its report tool.
	// The token cap stops a small model that falls into a repetition loop.
	if (helper) {
		pi.on("before_provider_request", (event) => {
			const payload = event.payload as Record<string, unknown>;
			const cap = (value: unknown) => Math.min(Number(value) || HELPER_MAX_TOKENS, HELPER_MAX_TOKENS);
			const capped: Record<string, unknown> = { ...payload, tool_choice: "required", max_tokens: cap(payload.max_tokens) };
			if ("max_completion_tokens" in payload) capped.max_completion_tokens = cap(payload.max_completion_tokens);
			return capped;
		});
	}

	pi.on("tool_call", async (event) => {
		if (event.toolName === "bash" || event.toolName === "powershell") {
			const { allowed, reason } = await call("gateCommand", { command: (event.input as any).command });
			if (!allowed) return { block: true, reason: reason ?? "The user declined to run this command." };
		}
		if (event.toolName === "write" || event.toolName === "edit") {
			const { allowed, reason } = await call("gateWrite", { path: (event.input as any).path, toolName: event.toolName });
			if (!allowed) return { block: true, reason: reason ?? "The user declined this file change." };
		}
		return undefined;
	});
}
