# Claude Code Logger

A specialized HTTP/HTTPS proxy logger designed for analyzing and debugging [Claude Code](https://claude.ai/code) traffic with enhanced chat mode visualization.

## 🎯 Primary Purpose

This tool was built specifically to help developers understand and debug the communication between Claude Code and the Anthropic API. It provides a clean, formatted view of the conversation flow, making it easier to:

- Debug Claude Code behavior
- Analyze API requests and responses
- Monitor token usage and quotas
- Understand the structure of system prompts and tool usage
- Archive conversations for later analysis

## 🚀 Quick Start (No Installation Required!)

Simply run these two commands in separate terminals:

**Terminal 1 - Start the logger:**
```bash
npx claude-code-logger start
```

**Terminal 2 - Start Claude Code with proxy:**
```bash
ANTHROPIC_BASE_URL=http://localhost:8000/ claude
```

That's it! You'll now see a beautifully formatted log of all Claude Code interactions in your terminal.

For help and options:
```bash
npx claude-code-logger start --help
```

## ✨ Features

### Claude Code Specific
- **🤖 Chat Mode**: Automatically enabled by default, shows only the conversation between you and Claude
- **📝 Markdown Rendering**: AI responses are rendered with proper formatting (lists, code blocks, emphasis)
- **🔍 System Prompt Visibility**: See system reminders, file contents, and context provided to Claude
- **🔧 Tool Usage Tracking**: Monitor when Claude uses tools like file reading, editing, or web searches
- **📊 Verbose Mode**: Use `-v` flag to see full prompts without truncation

### Multi-User Mode
- **👥 Shared Server**: Multiple users can share a single proxy server
- **🔗 URL-based Identification**: Users identified by URL path (`/user/<username>/...`)
- **📁 Per-user Logging**: Each user's traffic logged to separate JSONL files
- **🚀 No Pre-registration**: Users are automatically recognized

### General Proxy Features
- **✅ HTTP and HTTPS Support**: Works with both protocols
- **✅ Request/Response Logging**: Detailed logging of all traffic
- **✅ Body Content Logging**: Optional logging of request/response bodies
- **✅ Server-Sent Events (SSE)**: Proper handling and merging of streaming responses
- **✅ Compression Support**: Handles gzip, deflate, and brotli compressed responses
- **✅ Parallel Request Handling**: Efficiently handles multiple concurrent requests
- **❤️ Health Endpoints**: `/health` for monitoring

## 📋 All CLI Options

### Single-User Mode (start)

```bash
claude-code-logger start [options]

Options:
  -p, --port <port>         Local port to listen on (default: 8000)
  -h, --host <host>         Remote host address (default: api.anthropic.com)
  -r, --remote-port <port>  Remote port (default: 443)
  --https                   Use HTTPS for remote connection (default: true)
  --local-https             Accept HTTPS connections locally (default: false)
  --log-body                Log request and response bodies (default: false)
  --merge-sse               Merge Server-Sent Events into readable messages (default: false)
  --debug                   Show debug messages for troubleshooting (default: false)
  --chat-mode               Show only chat conversation with live streaming (default: true)
  -v, --verbose             Show full prompts without truncation (default: false)
```

### Multi-User Mode (server)

```bash
claude-code-logger server [options]

Options:
  -p, --port <port>         Local port to listen on (default: 8000)
  -b, --bind <address>      Bind address, 0.0.0.0 for all interfaces (default: 0.0.0.0)
  -h, --host <host>         Remote host address (default: api.anthropic.com)
  -r, --remote-port <port>  Remote port (default: 443)
  --logs-dir <path>         Directory for log files (default: ./logs)
  --https                   Use HTTPS for remote connection (default: true)
  --debug                   Show debug messages for troubleshooting (default: false)
  -v, --verbose             Show full prompts without truncation (default: false)
```

## 🔍 Usage Examples

### Claude Code Logging (Primary Use Case)
```bash
# Basic usage - logs Claude Code conversations
npm run dev -- start
ANTHROPIC_BASE_URL=http://localhost:8000/ claude

# With full prompt visibility
npm run dev -- start --verbose
ANTHROPIC_BASE_URL=http://localhost:8000/ claude

# With debug information
npm run dev -- start --debug
ANTHROPIC_BASE_URL=http://localhost:8000/ claude

# Log to file for later analysis
npm run dev -- start 2>&1 | tee claude-session-$(date +%Y%m%d-%H%M%S).log
```

### Multi-User Mode (Team/Server Setup)

**Server side:**
```bash
# Start multi-user server (binds to all interfaces)
npx claude-code-logger server -p 8000

# Or with specific bind address
npx claude-code-logger server -p 8000 -b 192.168.1.100
```

**Client side (each user):**
```bash
# Alice's configuration
export ANTHROPIC_BASE_URL="http://<server-ip>:8000/user/alice"
claude

# Bob's configuration
export ANTHROPIC_BASE_URL="http://<server-ip>:8000/user/bob"
claude
```

Logs are saved to `logs/<username>/YYYY-MM-DD-*.jsonl` for each user.

### General Proxy Usage
```bash
# Proxy any HTTP service
npm run dev -- start -p 3000 -h example.com -r 80 --https=false --chat-mode=false

# Log all traffic with bodies
npm run dev -- start -h api.example.com --log-body --chat-mode=false

# Debug mode for troubleshooting
npm run dev -- start --debug --log-body --chat-mode=false
```

## 📸 What You'll See

In chat mode (default), the output is clean and focused:

```
🚀 Proxy server started on http://localhost:8000
📡 Forwarding to https://api.anthropic.com:443
📝 Logging all traffic to console...

👤 How do I read a file in Python?

🤖 To read a file in Python, you can use the built-in `open()` function. Here are the most common approaches:

### Basic File Reading

```python
# Read entire file content
with open('filename.txt', 'r') as file:
    content = file.read()
    print(content)
```

... (formatted markdown output) ...
```

## 🛠 Development

```bash
# Install dependencies
npm install

# Run in development mode (single-user)
npm run dev -- start

# Run in development mode (multi-user)
npm run dev -- server

# Build for production
npm run build

# Type checking
npm run typecheck

# Linting
npm run lint
```

## 📦 Installation Options

### Option 1: Use without installation (Recommended)
```bash
npx claude-code-logger start
```

### Option 2: Install globally
```bash
npm install -g claude-code-logger
claude-code-logger start
```

## 🤝 Contributing

Contributions are welcome! This tool is specifically designed for Claude Code, but can be extended for other use cases.

## 📄 License

MIT

---

**Note**: This tool is not affiliated with Anthropic. It's an independent project designed to help developers work more effectively with Claude Code.