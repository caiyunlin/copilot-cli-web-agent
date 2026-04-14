# Architecture

## Overview

```
┌──────────────────────────────────────────────────────────────┐
│                  Dev Tunnel (Public Internet)                 │
│          https://xxxxx-3000.devtunnels.ms                    │
└──────────────────────┬───────────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────────┐
│                 Node.js Server (:3000)                        │
│                                                              │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────────┐ │
│  │  Express     │    │  WebSocket   │    │  ACP Client     │ │
│  │  Static File │◄──►│  Server      │◄──►│  (SDK)          │ │
│  │  Server      │    │  (ws)        │    │                 │ │
│  └─────────────┘    └──────────────┘    └────────┬────────┘ │
│                                                   │          │
└───────────────────────────────────────────────────┼──────────┘
                                                    │ stdio
                                          ┌─────────▼─────────┐
                                          │  copilot --acp    │
                                          │  --stdio           │
                                          │  (child process)   │
                                          └───────────────────┘
```

## Tech Stack

| Component | Technology | Description |
|-----------|-----------|-------------|
| Backend | Node.js + Express | HTTP server + static file hosting |
| Real-time | WebSocket (ws) | Bidirectional browser–server communication |
| ACP Client | `@agentclientprotocol/sdk` | Communicates with Copilot CLI via stdio NDJSON |
| Frontend | Vanilla HTML/CSS/JS | Responsive chat UI for desktop and mobile |
| Public Access | Microsoft Dev Tunnels | Maps local port to a public HTTPS URL |

## Data Flow

```
Browser                     Node.js Server              Copilot CLI (ACP)
    │                          │                            │
    │── WS: send message ─────►│                            │
    │                          │── ACP: prompt() ──────────►│
    │                          │                            │
    │                          │◄─ ACP: sessionUpdate ──────│
    │                          │   (agent_message_chunk)    │
    │◄─ WS: stream chunk ─────│                            │
    │◄─ WS: stream chunk ─────│                            │
    │◄─ WS: stream done ──────│                            │
    │                          │                            │
    │── WS: send message ─────►│                            │
    │                          │── ACP: prompt() ──────────►│
    │                          │   (same sessionId)         │
    │                          │◄─ ACP: sessionUpdate ──────│
    │◄─ WS: stream chunk ─────│                            │
    │◄─ WS: stream done ──────│                            │
```

## Project Structure

```
copilot-cli-web-agent/
├── README.md              # Quick start guide
├── Architecture.md        # This document
├── package.json           # Node.js dependencies
├── tsconfig.json          # TypeScript configuration
├── src/
│   ├── server.ts          # Express + WebSocket server
│   ├── acp-client.ts      # ACP connection management (spawn copilot, SDK interaction)
│   └── types.ts           # WebSocket message type definitions
├── public/
│   ├── index.html         # Chat page
│   ├── style.css          # Responsive styles
│   └── app.js             # Frontend WebSocket + chat logic
└── scripts/
    └── start.ps1          # One-click start script (server + devtunnel)
```

## Core Module Design

### 1. ACP Client (`src/acp-client.ts`)

Spawns the Copilot CLI child process and manages sessions via the ACP SDK:

```typescript
import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";

// Start Copilot CLI as an ACP child process
const copilotProcess = spawn("copilot", ["--acp", "--stdio"], {
  stdio: ["pipe", "pipe", "inherit"],
});

// Create NDJSON stream
const output = Writable.toWeb(copilotProcess.stdin);
const input = Readable.toWeb(copilotProcess.stdout);
const stream = acp.ndJsonStream(output, input);

// Initialize connection & create session
await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });

// Send prompt, stream responses back
await connection.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: userMessage }],
});
```

Key points:
- **Session reuse**: Each WebSocket connection maps to an ACP session, maintaining conversation context
- **Streaming output**: `sessionUpdate` callback delivers `agent_message_chunk` events in real time to the frontend
- **Permission control**: `requestPermission` callback determines whether to allow Copilot tool calls (e.g. file operations, command execution)

### 2. WebSocket Server (`src/server.ts`)

Bridges the browser and ACP Client:

```typescript
// WebSocket message protocol
interface WSMessage {
  type: "chat" | "status" | "chunk" | "done" | "error" | "permission_request" | "permission_response";
  content?: string;
  requestId?: string;
}
```

- Each WS connection → creates an independent ACP session
- User messages → `connection.prompt()`
- ACP streaming chunks → forwarded to the browser via WS
- Tool call permission requests → forwarded to the frontend for user confirmation

### 3. Frontend Chat UI (`public/`)

Responsive design supporting both desktop and mobile:

```
┌─────────────────────────────────────┐
│  🤖 Copilot CLI Web Agent           │  ← Header
├─────────────────────────────────────┤
│                                     │
│  [User] List files in current dir   │
│                                     │
│  [Copilot] Here are the files:      │  ← Message stream
│  - README.md                        │
│  - package.json                     │
│  ...                                │
│                                     │
├─────────────────────────────────────┤
│  [Input field...............] [Send]│  ← Input area
└─────────────────────────────────────┘
```

Features:
- **Markdown rendering**: Uses `marked` to render code blocks, lists, etc. in AI responses
- **Streaming display**: Text appended chunk by chunk with a typewriter effect
- **Mobile-friendly**: `viewport` meta + `max-width` layout + touch-friendly input area
- **Permission confirmation dialog**: Pops up when Copilot needs to execute a tool
- **Connection status indicator**: Shows WebSocket connected/disconnected state
