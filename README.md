# ⚡ AI Auto Agent

[中文文档](README.zh-CN.md) | [English](README.md)

<p align="center">
  <img src="assets/icon.png" width="128" alt="AI Auto Agent Logo">
</p>

**Automated AI agent assistant for [Antigravity](https://antigravity.dev)** — auto-retry on failures, auto-accept edits, smart model rotation when quota runs out.

> **Run your agents hands-free. Walk away. Come back to finished work.**

---

## ✨ Features

| Feature                           | Description                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| **🔄 Auto Retry**                 | Automatically clicks Retry / Continue when the agent hits errors or invocation limits             |
| **✅ Auto Accept**                | Auto-accepts file edits, terminal commands (Run), and permission prompts (Allow/Always Allow)     |
| **🔀 Model Rotation**             | Automatically switches to the next model when API quota is exhausted — _unique to this extension_ |
| **🛡 Dangerous Command Blocking** | Blocks destructive commands (`rm -rf`, `mkfs`, etc.) with word-boundary matching                  |
| **🔌 Multi-Session CDP**          | Connects to all webview targets simultaneously — works across multiple windows                    |
| **⚡ MutationObserver**           | Event-driven button detection (~100ms) instead of polling — zero missed clicks                    |

### 🔀 Model Rotation — How It Works

When the agent encounters a "quota exceeded" or "rate limit" error:

```
gemini-2.5-pro (quota hit) → claude-4-sonnet → gemini-2.5-flash → claude-4-opus → gemini-2.5-pro ...
```

1. Detects quota/rate-limit error in the agent panel
2. Auto-switches to the next model in your rotation list
3. Resets retry counter
4. Agent continues seamlessly on the new model

---

## 🚀 Setup

### 1. Enable Debug Mode (Required)

Launch Antigravity with the CDP flag:

```bash
# Quick start (one-time)
open -a "Antigravity" --args --remote-debugging-port=9333
```

For permanent setup, add an alias:

```bash
# macOS (add to ~/.zshrc)
alias antigravity='open -a "Antigravity" --args --remote-debugging-port=9333'

# Linux (edit .desktop file or alias)
alias antigravity='antigravity --remote-debugging-port=9333'

# Windows (right-click shortcut → Properties → append to Target)
--remote-debugging-port=9333
```

> ⚠️ **Important:** If Antigravity is already running, you must quit it first before relaunching with the CDP flag. The `--args` flag is only applied on fresh launch.

> **Why port 9333?** Antigravity's built-in Browser Control uses port 9222. Using 9333 avoids `EADDRINUSE` conflicts.

### 2. Install the Extension

**From VSIX:**

1. Download the `.vsix` from [Releases](https://github.com/double12gzh/ai-auto-agent/releases)
2. `Ctrl+Shift+P` → `Extensions: Install from VSIX`
3. Select the file → Reload Window

### 3. Usage

- **Toggle:** `Cmd+Shift+A` (macOS) / `Ctrl+Shift+A` (Windows/Linux)
- **Status Bar:** Click `⚡ AAA` to toggle on/off
- **Dashboard:** `Ctrl+Shift+P` → `AI Auto Agent: Show Dashboard`
- **Select Models:** `Ctrl+Shift+P` → `AI Auto Agent: Select Models for Rotation` (Dynamically fetch and select available models from the IDE)

---

## 🛠️ Development

If you want to build and modify the extension locally from source or contribute, please ensure your development environment meets the following requirements:

### Prerequisites

- **Node.js**: `v22.x` is highly recommended (aligned with our CI/CD pipeline).
- **Editor**: VS Code `v1.100.0+` or Antigravity IDE.
- **Extensions**: We strongly recommend installing the **ESLint** and **Prettier** extensions in your IDE for real-time code style feedback.
- **Testing Environment**: You MUST launch the Antigravity IDE with the `--remote-debugging-port=9333` flag to enable CDP monitoring for extension testing.

### Getting Started

```bash
# 1. Install dependencies (auto-configures Husky pre-commit Git hooks)
npm install

# 2. Start development (watch mode)
npm run watch

# 3. Global code style check & auto-fix (Powered by ESLint & Prettier)
npm run format
npm run lint

# 4. Run unit tests
npm run test

# 5. Compile and package manually into a .vsix file (Releases are usually handled by CI)
npm run package
```

> **Note:** The project runs a GitHub Actions CI workflow. Every push triggers automated Linting, TypeScript type-checking, and Unit Tests. Pushing a `v*` tag will automatically publish the extension to the marketplaces and GitHub Releases.

---

## ⚙️ Configuration

| Setting                              | Default                   | Description                                  |
| ------------------------------------ | ------------------------- | -------------------------------------------- |
| `ai-auto-agent.enabled`              | `true`                    | Enable/disable the extension                 |
| `ai-auto-agent.cdpPort`              | `9333`                    | CDP debugging port                           |
| `ai-auto-agent.autoRetry`            | `true`                    | Auto-retry on agent failures                 |
| `ai-auto-agent.autoRetryMaxAttempts` | `5`                       | Max retries before triggering model rotation |
| `ai-auto-agent.autoRetryDelayMs`     | `2000`                    | Delay between retries (ms)                   |
| `ai-auto-agent.autoAccept`           | `false`                   | Auto-accept edits and commands (opt-in)      |
| `ai-auto-agent.dangerousCommands`    | `["rm -rf", ...]`         | Commands that will NEVER be auto-accepted    |
| `ai-auto-agent.modelRotation`        | `true`                    | Auto-switch model on quota exhaustion        |
| `ai-auto-agent.modelList`            | `["gemini-2.5-pro", ...]` | Ordered model rotation list                  |

> All settings are hot-reloaded — changes take effect immediately.

---

## 🔥 Running Multiple Agents (Recommended Setup)

Antigravity's Agent Manager uses a **single shared webview** — only the active conversation renders its DOM. Background agents **block on approval buttons** that the extension cannot reach.

**Solution: Duplicate Workspace**

1. Open your project in Antigravity
2. Click **File → Duplicate Workspace**
3. Each window gets its own webview with a live DOM
4. Start a different agent task in each window
5. The extension auto-accepts in **all windows simultaneously**

```
Window 1: Agent → "Implement user auth"     ← ✅ auto-clicking
Window 2: Agent → "Write unit tests"        ← ✅ auto-clicking
Window 3: Agent → "Add API documentation"   ← ✅ auto-clicking
```

> **Start 5 agents. Minimize. Walk away. Come back to finished code.**

---

## 🏗 Architecture

```
extension.ts
├── cdp/
│   ├── cdpClient.ts     — Multi-session WebSocket manager (vscode-webview:// targets)
│   └── domMonitor.ts    — MutationObserver injection + heartbeat self-healing
└── features/
    ├── autoAccept.ts    — Accept edits, commands, permissions
    ├── autoRetry.ts     — Retry/Continue with max-attempt tracking
    └── modelRotation.ts — Quota detection + model cycling
```

### How CDP Works

```
Antigravity (--remote-debugging-port=9333)
│
├── /json endpoint → discovers vscode-webview:// targets
│
├── WebSocket Session 1 → webview (Window 1 agent panel)
│   └── MutationObserver injected → clicks buttons → reports via Runtime.addBinding
│
├── WebSocket Session 2 → webview (Window 2 agent panel)
│   └── MutationObserver injected → clicks buttons → reports via Runtime.addBinding
│
└── Heartbeat (10s) → validates sessions, re-injects dead observers
```

### Button Detection Priority

| Priority | Keyword                        | Matches                           |
| -------- | ------------------------------ | --------------------------------- |
| 1        | `run`                          | "Run Alt+d" ✅ (not "Always run") |
| 2        | `accept` / `接受`              | Accept button                     |
| 3        | `always allow`                 | Permission prompts                |
| 4        | `allow this conversation`      | Conversation-scoped permissions   |
| 5        | `allow` / `允许`               | Permission prompts                |
| 6        | `retry` / `重试` / `try again` | Retry prompts                     |
| 7        | `continue` / `继续`            | Agent invocation limit resume     |

---

## 🔒 Safety

- **Dangerous commands are blocked** — word-boundary matching prevents false positives
- **Auto-accept is opt-in** (default: `false`) — you must explicitly enable it
- **CDP is localhost only** — port binds to `127.0.0.1`, not `0.0.0.0`
- **Fully open source** — no telemetry, no network requests, no data collection
- **UI-only extension** — runs entirely on your local machine, never touches remote servers

---

## 📄 License

MIT
