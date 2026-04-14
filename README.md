# Copilot CLI Web Agent

A Web UI for interacting with GitHub Copilot CLI via the Agent Client Protocol (ACP), with optional public access through Microsoft Dev Tunnels.

For detailed architecture and design docs, see [Architecture.md](Architecture.md).

## Prerequisites

1. **Node.js** ≥ 18   
   Download and install from https://nodejs.org 
2. **GitHub Copilot CLI** installed and authenticated
   ```bash
   # Install
   npm install -g @githubnext/github-copilot-cli
   # Verify authentication
   copilot --version
   # Login Copilot CLI
   copilot login
   ```
3. **Microsoft Dev Tunnels CLI** installed and logged in
   ```powershell
   # Install: https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started
   winget install Microsoft.devtunnel
   # Login 
   devtunnel login -g
   ```

## Quick Start

```bash
npm install
```

Then run the one-click start script:

```powershell
.\scripts\start.ps1 -Port 3000 -Cwd "c:\your\workfolder" -CliArgs "--yolo" -Password "YourSecretHere"
```

This installs dependencies, builds TypeScript, starts the Node.js server, and exposes it via Dev Tunnel. The public URL will be printed in the terminal. Click the URL (e.g. `https://l3rs99qw-3000.usw2.devtunnels.ms`) to access the web agent.

### Manual Setup (Step by Step)

If you prefer to start each component separately:

**Build and start the server:**

```bash
npm run build
npm start
```

The server starts at `http://localhost:3000` by default.

**Expose via Dev Tunnel (optional):**

In a new terminal:

```powershell
# Temporary tunnel (anonymous access)
devtunnel host -p 3000 --allow-anonymous

# Or create a persistent tunnel
devtunnel create -a
devtunnel port create -p 3000 --protocol https
devtunnel host
```

The terminal will output a public URL like:
```
Hosting port 3000 at https://l3rs99qw-3000.usw2.devtunnels.ms/
```


## Security Notes

- **`--allow-anonymous`** makes the tunnel accessible to anyone with the URL. Remove this flag and use Dev Tunnel's built-in authentication if public access is not needed.
- **Tool call permissions**: Copilot's file operations and command execution requests require manual user confirmation in the Web UI by default, preventing unauthorized actions.
- **Production use**: This project is intended for development and demos only. Do not use `--allow-anonymous` tunnels in production.

## References

- [Copilot CLI ACP Server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
- [ACP Protocol Documentation](https://agentclientprotocol.com/protocol/overview)
- [ACP TypeScript SDK](https://agentclientprotocol.com/libraries/typescript)
- [Microsoft Dev Tunnels CLI](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/cli-commands)
