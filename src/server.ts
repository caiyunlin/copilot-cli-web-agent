import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { AcpClient } from "./acp-client.js";
import type { AcpClientOptions } from "./acp-client.js";
import type { WSIncomingMessage, WSOutgoingMessage } from "./types.js";

// --- CLI argument parsing ---
// --cwd <path>         Working directory for Copilot CLI sessions
// --cli-args <args>    Extra args passed to copilot CLI (comma-separated)
// --password <pwd>     Require password before chatting
function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const result: { cwd?: string; cliArgs?: string[]; password?: string } = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--cwd":
        result.cwd = args[++i];
        break;
      case "--cli-args":
        result.cliArgs = args[++i]?.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--password":
        result.password = args[++i];
        break;
    }
  }
  return result;
}

const cliConfig = parseArgs(process.argv);
const AUTH_PASSWORD = cliConfig.password || process.env.AUTH_PASSWORD || "";
const acpOptions: AcpClientOptions = {
  cwd: cliConfig.cwd,
  cliArgs: cliConfig.cliArgs,
};

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const app = express();
const server = createServer(app);

// Serve static files
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "..", "public")));

// Config endpoint — tells frontend whether auth is required
app.get("/config", (_req, res) => {
  res.json({ authRequired: !!AUTH_PASSWORD });
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// WebSocket server
const wss = new WebSocketServer({ server, path: "/ws" });

// Global session store: deviceId → AcpClient (persists across WS reconnects)
const sessionStore = new Map<string, AcpClient>();

wss.on("connection", (ws) => {
  console.log("[WS] New client connected");

  let acpClient: AcpClient | null = null;
  let prompting = false;
  let authenticated = !AUTH_PASSWORD;
  let deviceId: string | null = null;

  const send = (msg: WSOutgoingMessage) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };

  // Create a brand-new ACP session and store it under the deviceId
  const createNewSession = async () => {
    // Destroy existing session for this device if any
    if (deviceId && sessionStore.has(deviceId)) {
      const old = sessionStore.get(deviceId)!;
      await old.destroy();
      sessionStore.delete(deviceId);
    }
    send({ type: "status", content: "Starting Copilot ACP session..." });
    acpClient = new AcpClient(send, acpOptions);
    if (deviceId) sessionStore.set(deviceId, acpClient);
    try {
      await acpClient.start();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      send({ type: "error", content: `Failed to start ACP: ${message}` });
      if (deviceId) sessionStore.delete(deviceId);
      acpClient = null;
    }
  };

  // Try to restore an existing session, or create a new one
  const initOrRestore = async () => {
    if (deviceId && sessionStore.has(deviceId)) {
      const existing = sessionStore.get(deviceId)!;
      if (existing.isAlive) {
        acpClient = existing;
        acpClient.rebindSender(send);
        send({ type: "session_restored", content: "Previous session restored" });
        console.log(`[WS] Restored session for device ${deviceId}`);
        return;
      }
      // Dead session — clean up
      sessionStore.delete(deviceId);
    }
    await createNewSession();
  };

  ws.on("message", async (raw) => {
    let msg: WSIncomingMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send({ type: "error", content: "Invalid message format." });
      return;
    }

    // init must come first — carries the deviceId
    if (msg.type === "init") {
      deviceId = msg.deviceId || null;
      if (AUTH_PASSWORD && !authenticated) {
        send({ type: "auth_required" });
      } else {
        await initOrRestore();
      }
      return;
    }

    // Handle auth
    if (msg.type === "auth") {
      if (!AUTH_PASSWORD) {
        authenticated = true;
        send({ type: "auth_ok" });
        return;
      }
      if (msg.password === AUTH_PASSWORD) {
        authenticated = true;
        send({ type: "auth_ok" });
        await initOrRestore();
      } else {
        send({ type: "auth_fail", content: "Incorrect password" });
      }
      return;
    }

    // Block all other messages until authenticated
    if (!authenticated) {
      send({ type: "auth_required" });
      return;
    }

    if (msg.type === "new_session") {
      prompting = false;
      await createNewSession();
      return;
    }

    if (msg.type === "chat") {
      if (!acpClient) {
        send({ type: "error", content: "ACP session not ready. Please wait or reconnect." });
        return;
      }
      if (prompting) {
        send({ type: "error", content: "Please wait for the current response to finish." });
        return;
      }
      if (!msg.content?.trim()) {
        return;
      }

      prompting = true;
      await acpClient.prompt(msg.content);
      prompting = false;
    } else if (msg.type === "permission_response") {
      if (acpClient && msg.requestId != null) {
        acpClient.resolvePermission(msg.requestId, msg.allowed === true);
      }
    }
  });

  ws.on("close", () => {
    console.log("[WS] Client disconnected" + (deviceId ? ` (device: ${deviceId})` : ""));
    // Don't destroy acpClient — it stays in sessionStore for reconnection
    acpClient = null;
  });

  ws.on("error", (err) => {
    console.error("[WS] Error:", err.message);
    acpClient = null;
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
  if (acpOptions.cwd) console.log(`Copilot CLI working directory: ${acpOptions.cwd}`);
  if (acpOptions.cliArgs?.length) console.log(`Copilot CLI extra args: ${acpOptions.cliArgs.join(" ")}`);
  if (AUTH_PASSWORD) console.log("Password protection: enabled");
});
