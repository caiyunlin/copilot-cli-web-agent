import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { WSOutgoingMessage } from "./types.js";

export interface AcpClientOptions {
  cwd?: string;
  cliArgs?: string[];
}

export class AcpClient {
  private copilotProcess: ChildProcess | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private onMessage: (msg: WSOutgoingMessage) => void;
  private permissionResolvers = new Map<string, (allowed: boolean) => void>();
  private permissionOptions = new Map<string, acp.PermissionOption[]>();
  private requestCounter = 0;
  private options: AcpClientOptions;

  constructor(onMessage: (msg: WSOutgoingMessage) => void, options?: AcpClientOptions) {
    this.onMessage = onMessage;
    this.options = options ?? {};
  }

  async start(): Promise<void> {
    const executable = process.env.COPILOT_CLI_PATH || "copilot";
    const baseArgs = ["--acp", "--stdio"];
    const extraArgs = this.options.cliArgs ?? [];
    const allArgs = [...baseArgs, ...extraArgs];
    const cwd = this.options.cwd || process.cwd();

    this.copilotProcess = spawn(executable, allArgs, {
      stdio: ["pipe", "pipe", "inherit"],
      cwd,
    });

    this.copilotProcess.on("error", (err) => {
      this.onMessage({ type: "error", content: `Copilot process error: ${err.message}` });
    });

    this.copilotProcess.on("exit", (code) => {
      this.onMessage({ type: "status", content: `Copilot process exited with code ${code}` });
      this.connection = null;
      this.sessionId = null;
    });

    if (!this.copilotProcess.stdin || !this.copilotProcess.stdout) {
      throw new Error("Failed to start Copilot ACP process with piped stdio.");
    }

    const output = Writable.toWeb(this.copilotProcess.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(this.copilotProcess.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);

    const self = this;
    const client: acp.Client = {
      async requestPermission(params) {
        const requestId = `perm_${++self.requestCounter}`;
        const toolCall = params.toolCall;
        const description = `Tool call: ${toolCall.toolName}`;

        // Store options for later resolution
        self.permissionOptions.set(requestId, params.options);

        self.onMessage({
          type: "permission_request",
          requestId,
          description,
          content: JSON.stringify(toolCall, null, 2),
        });

        const allowed = await new Promise<boolean>((resolve) => {
          self.permissionResolvers.set(requestId, resolve);
          // Auto-timeout after 60s — deny by default
          setTimeout(() => {
            if (self.permissionResolvers.has(requestId)) {
              self.permissionResolvers.delete(requestId);
              self.permissionOptions.delete(requestId);
              resolve(false);
            }
          }, 60_000);
        });

        const options = self.permissionOptions.get(requestId) ?? params.options;
        self.permissionOptions.delete(requestId);

        if (allowed) {
          // Pick the first allow_once option
          const allowOption = options.find((o: acp.PermissionOption) => o.kind === "allow_once")
            ?? options.find((o: acp.PermissionOption) => o.kind === "allow_always");
          if (allowOption) {
            return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
          }
        }

        return { outcome: { outcome: "cancelled" } };
      },

      async sessionUpdate(params) {
        const update = params.update;
        if (
          update.sessionUpdate === "agent_message_chunk" &&
          update.content.type === "text"
        ) {
          self.onMessage({ type: "chunk", content: update.content.text });
        }
      },
    };

    this.connection = new acp.ClientSideConnection((_agent) => client, stream);

    await this.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    const sessionResult = await this.connection.newSession({
      cwd,
      mcpServers: [],
    });

    this.sessionId = sessionResult.sessionId;
    this.onMessage({ type: "status", content: "Copilot ACP session ready." });
  }

  async prompt(text: string): Promise<void> {
    if (!this.connection || !this.sessionId) {
      this.onMessage({ type: "error", content: "ACP session not initialized." });
      return;
    }

    try {
      const result = await this.connection.prompt({
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      });

      this.onMessage({
        type: "done",
        content: result.stopReason === "end_turn" ? undefined : `Stop reason: ${result.stopReason}`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.onMessage({ type: "error", content: `Prompt error: ${message}` });
    }
  }

  resolvePermission(requestId: string, allowed: boolean): void {
    const resolver = this.permissionResolvers.get(requestId);
    if (resolver) {
      this.permissionResolvers.delete(requestId);
      resolver(allowed);
    }
  }

  /** Re-bind the message sender when a new WebSocket takes over this session */
  rebindSender(onMessage: (msg: WSOutgoingMessage) => void): void {
    this.onMessage = onMessage;
  }

  /** Whether the ACP session is alive and usable */
  get isAlive(): boolean {
    return this.connection !== null && this.sessionId !== null;
  }

  async destroy(): Promise<void> {
    // Reject all pending permissions
    for (const [id, resolver] of this.permissionResolvers) {
      resolver(false);
      this.permissionResolvers.delete(id);
    }
    this.permissionOptions.clear();

    if (this.copilotProcess) {
      this.copilotProcess.stdin?.end();
      this.copilotProcess.kill("SIGTERM");
      this.copilotProcess = null;
    }
    this.connection = null;
    this.sessionId = null;
  }
}
