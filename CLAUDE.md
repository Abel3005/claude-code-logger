# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Logger is an HTTP/HTTPS proxy server that intercepts and logs traffic between Claude Code and the Anthropic API. It provides readable visualization of conversations, including markdown rendering for responses. Supports both single-user and multi-user modes.

## Commands

```bash
# Development
npm run dev -- start              # Run with ts-node (single-user)
npm run dev -- start --debug      # With debug output
npm run dev -- start --verbose    # Full prompts without truncation
npm run dev -- server             # Run multi-user server

# Build & Quality
npm run build                     # Compile TypeScript to dist/
npm run typecheck                 # Type checking only
npm run lint                      # ESLint

# Production (Single-user)
npm start                         # Run compiled version
npx claude-code-logger start      # Run from npm

# Production (Multi-user)
npx claude-code-logger server     # Start multi-user server
```

## Architecture

The codebase consists of the following files:

- **src/cli.ts**: CLI entry point using Commander.js. Parses options and instantiates ProxyServer.
- **src/proxy-server.ts**: Core proxy implementation with:
  - HTTP/HTTPS request forwarding to `api.anthropic.com`
  - SSE (Server-Sent Events) stream parsing for real-time AI responses
  - Markdown rendering via `marked` + `marked-terminal`
  - Compression handling (gzip, deflate, brotli)
  - Chat mode extraction that parses Claude API message format
  - Multi-user support via URL path-based user identification
  - Per-user logging and request context tracking
- **src/file-logger.ts**: Per-user file logging. Writes JSONL logs to `logs/<username>/` directory.

## Multi-User Mode

Multi-user mode allows multiple users to share a single proxy server with:
- **URL Path-based User Identification**: Users include their username in the URL path
- **Per-user logging**: Each user's traffic is logged to separate files in `logs/<username>/`
- **No pre-registration required**: Users are automatically identified by their URL path

### How It Works

```
[Claude Code]                        [Proxy Server]              [Anthropic API]
     │                                    │                           │
     ├─ POST /user/alice/v1/messages ────►│                           │
     │                                    ├─ Extract user: "alice"    │
     │                                    ├─ POST /v1/messages ──────►│
     │                                    │                           │
     │◄───────────────────────────────────┼◄──────────────────────────┤
```

### Server Setup

```bash
# Start multi-user server (binds to all interfaces by default)
claude-code-logger server -p 8000

# Or with specific bind address
claude-code-logger server -p 8000 -b 192.168.1.100
```

### Client Configuration

Each user sets `ANTHROPIC_BASE_URL` with their username in the path:

```bash
# Alice's configuration
export ANTHROPIC_BASE_URL="http://<server-ip>:8000/user/alice"

# Bob's configuration
export ANTHROPIC_BASE_URL="http://<server-ip>:8000/user/bob"
```

The proxy server:
1. Extracts username from URL path (`/user/<username>/...`)
2. Removes the `/user/<username>` prefix before forwarding to Anthropic API
3. Logs traffic to user-specific files

## Key Implementation Details

**URL Path Parsing**: The `parseUserPath` method extracts username from URLs matching `/user/<username>/<path>`.

**Chat Mode (default)**: Extracts and displays only conversation content from Claude API requests/responses. Handles:
- `messages` array from requests (user prompts, tool results, system reminders)
- `content_block_delta` SSE events for streaming responses
- Non-streaming responses via `data.content` array

**SSE Processing**: The `processSseStream` method accumulates text deltas across multiple chunks, renders markdown at stream completion (on `message_stop`, `content_block_stop`, or `message_delta` with `stop_reason`).

**Message Extraction**: `extractChatMessage` parses JSON bodies to find user messages (including `<system-reminder>` tags and file contents) and assistant responses.

**Logging**: `FileLogger` writes JSONL files per user per day:
- `logs/<username>/YYYY-MM-DD-raw.jsonl` - Raw request/response logs
- `logs/<username>/YYYY-MM-DD-chat.jsonl` - Chat messages only
