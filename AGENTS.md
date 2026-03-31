# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # Compile TypeScript to dist/
npm run dev            # Run directly with tsx (no build needed)
npm start              # Run compiled output (requires build first)
npm test               # Run all tests
tsx --test src/jmap-client.test.ts  # Run a single test file
```

## Architecture

This is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that exposes 38 tools for interacting with the Fastmail email/contacts/calendar service via the JMAP protocol.

### Source Files

- **`src/auth.ts`** — `FastmailAuth` class: holds API token, builds auth headers and endpoint URLs. Simple, rarely changes.
- **`src/jmap-client.ts`** — Core JMAP client (`JmapClient` class). All email/mailbox/attachment/search operations live here. Makes JMAP method calls via `makeRequest()`, handles session bootstrapping, identity resolution, and JMAP result references (`#ids` with `resultOf` for chained calls).
- **`src/contacts-calendar.ts`** — `ContactsCalendarClient` extends `JmapClient` with contacts (CardDAV-via-JMAP) and calendar operations. Checks for permissions before calling APIs and includes helpful error messages when unavailable.
- **`src/mcp-server.ts`** — MCP server factory and tool handlers. Registers all 38 tools, handles request dispatch, coerces JSON-encoded string args from web clients, normalizes address arrays, and resolves Fastmail config into per-session runtime contexts.
- **`src/http-server.ts`** — HTTP transport/session manager. Creates isolated MCP server instances per HTTP session, enforces body/session limits, expires idle sessions, and returns structured JSON-RPC errors for malformed HTTP requests.
- **`src/index.ts`** — Startup entry point. Chooses stdio vs HTTP mode and delegates to the appropriate server bootstrap code.

### Key Patterns

**JMAP chaining:** Many operations use JMAP result references — e.g., a `query` call returns an ID, and a subsequent `get` call references it with `"#ids": {"resultOf": "...", "name": "...", "path": "/ids"}`. This avoids two round trips.

**Arg coercion in `mcp-server.ts`:** The `coerceArgs` function handles the case where web UIs send tool arguments as JSON strings instead of parsed objects. Any new tools that accept arrays or objects need to be supported there.

**Per-session runtime context:** In HTTP mode, each MCP session gets its own `FastmailClientContext`, which lazily creates and caches `JmapClient` / `ContactsCalendarClient` instances. This avoids sharing one process-global Fastmail client across multiple HTTP clients.

**Environment variable resolution:** `mcp-server.ts` resolves `FASTMAIL_API_TOKEN` from multiple env var names (to support CLI, Docker, and DXT deployment contexts). It also detects unset placeholder values like `${FASTMAIL_API_TOKEN}` and throws a clear error.

**Dry-run support:** Bulk operations (`bulk_mark_read`, `bulk_move`, `bulk_delete`) accept a `dryRun` boolean. Always respect this flag when implementing new bulk tools.

### Configuration

- **`FASTMAIL_API_TOKEN`** (required) — Fastmail API token
- **`FASTMAIL_BASE_URL`** (optional) — defaults to `https://api.fastmail.com`
- **`.mcp.json`** — local MCP server config for Codex Desktop / CLI
- **`manifest.json`** — DXT (Codex Desktop Extension) packaging metadata; bump the `version` field here when releasing

### Testing

Tests use Node's built-in `node:test` module with `node:assert/strict`. `src/jmap-client.test.ts` mocks `getSession()`, `getIdentities()`, `getMailboxes()`, and `makeRequest()` on `JmapClient` to avoid network calls. `src/http-server.test.ts` covers HTTP session lifecycle behavior with fake transports and in-process HTTP requests. Tests remain unit-level; there are no live Fastmail integration tests.
