# Fastmail MCP Server

A Model Context Protocol (MCP) server for Fastmail email, enabling AI assistants to read inbox mail, search messages, page through large result sets, send and reply to email, and manage drafts.

Tool descriptions are written as routing hints for MCP clients, so prompts like "check email", "read my inbox", "reply to this email", and "save a draft" map more reliably to the right Fastmail tools.

## Features

### Core Email Operations
- List mailboxes and get mailbox statistics
- List, search, and filter emails with advanced criteria
- Get specific emails by ID with full content
- Send emails (text and HTML) with proper draft/sent handling
- Reply to emails with proper threading (In-Reply-To, References headers)
- Create and save email drafts (with or without threading)
- Email management: mark read/unread, delete, move between folders

### Advanced Email Features
- **Attachment Handling**: List and download email attachments
- **Threading Support**: Get complete conversation threads
- **Advanced Search**: Multi-criteria filtering (sender, date range, attachments, read status)
- **Bulk Operations**: Process multiple emails simultaneously
- **Statistics & Analytics**: Account summaries and mailbox statistics

### Label vs Move Operations
- **move_email/bulk_move**: Replaces ALL mailboxes for an email (folder behavior)
- **add_labels/remove_labels**: Adds/removes SPECIFIC mailboxes while preserving others (label behavior)

### Identity & Account Management
- List available sending identities
- Account summary with comprehensive statistics

## Setup

### Prerequisites
- Node.js 18+ 
- A Fastmail account with API access
- Fastmail API token

### Installation

1. Clone or download this repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

### Configuration

1. Get your Fastmail API token:
   - Log in to Fastmail web interface
   - Go to Settings → Privacy & Security
   - Find "Connected apps & API tokens" section
   - Click "Manage API tokens"
   - Click "New API token"
   - Copy the generated token

2. Set environment variables:
   ```bash
   export FASTMAIL_API_TOKEN="your_api_token_here"
   # Optional: customize base URL (defaults to https://api.fastmail.com)
   export FASTMAIL_BASE_URL="https://api.fastmail.com"
   ```

### Running the Server

Start the MCP server:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

### Remote HTTP Mode for ChatGPT / Hosted MCP

You can also run the server as a private remote MCP endpoint by setting `MCP_PATH`.
This mode is intended for a small number of trusted clients that all use the same Fastmail account.

```bash
export FASTMAIL_API_TOKEN="your_api_token_here"
export MCP_PATH="replace-with-a-long-random-secret-path"
export PORT="3000"

# Optional operational limits
export MCP_MAX_SESSIONS="10"
export MCP_SESSION_TTL_MS="900000"
export MCP_REAP_INTERVAL_MS="60000"
export MCP_MAX_BODY_BYTES="1048576"

npm start
```

Behavior in HTTP mode:
- The server is single-tenant: every MCP session uses the same Fastmail token from the environment.
- Stateless sessionless `POST` requests are the default hosted path; most remote MCP clients do not need to send `mcp-session-id`.
- ChatGPT-compatible auth is expected to happen at the infrastructure layer, not via OAuth in this server.
- Do not assume ChatGPT will send arbitrary custom bearer tokens to your MCP endpoint.
- Protect the endpoint with a high-entropy `MCP_PATH`, and optionally add reverse-proxy controls such as IP allowlists if they fit your deployment.
- If a client opts into explicit stateful sessions, they are isolated in-process, expire after idle timeout, and are capped by `MCP_MAX_SESSIONS`.
- Oversized bodies are rejected and invalid session requests return structured JSON-RPC errors.

### Run via npx (GitHub)

Default to `main` branch:

```bash
FASTMAIL_API_TOKEN="your_token" FASTMAIL_BASE_URL="https://api.fastmail.com" \
  npx --yes github:MadLlama25/fastmail-mcp fastmail-mcp
```

Windows PowerShell:

```powershell
$env:FASTMAIL_API_TOKEN="your_token"
$env:FASTMAIL_BASE_URL="https://api.fastmail.com"
npx --yes github:MadLlama25/fastmail-mcp fastmail-mcp
```

Pin to a tagged release:

```bash
FASTMAIL_API_TOKEN="your_token" \
  npx --yes github:MadLlama25/fastmail-mcp@v1.7.1 fastmail-mcp
```

## Install as a Claude Desktop Extension (DXT)

You can install this server as a Desktop Extension for Claude Desktop using the packaged `.dxt` file.

1. Build and pack:
   ```bash
   npm run build
   npx @anthropic-ai/dxt pack
   ```
   This produces `fastmail-mcp.dxt` in the project root.

2. Install into Claude Desktop:
   - Open the `.dxt` file, or drag it into Claude Desktop
   - When prompted:
     - Fastmail API Token: paste your token (stored encrypted by Claude)
     - Fastmail Base URL: leave blank to use `https://api.fastmail.com` (default)

3. Use any of the tools (e.g. `get_recent_emails`).

## Available Tools (28 Total)

**🎯 Most Popular Tools:**
- **check_function_availability**: Check what's available and get setup guidance  
- **test_bulk_operations**: Safely test bulk operations with dry-run mode
- **send_email**: Full-featured email sending with proper draft/sent handling
- **advanced_search**: Powerful multi-criteria email filtering
- **get_recent_emails**: Quick access to recent emails from any mailbox, especially for prompts like "check email"
- Paged email tools now return `items`, `total`, `has_more`, and `next_offset` so agents can fetch more only when needed.

### Email Tools

- **list_mailboxes**: Get all mailboxes in your account
- **list_emails**: List emails from a specific mailbox or all mailboxes
  - Parameters: `mailboxId` (optional), `limit` (default: 20), `offset` (default: 0)
- **get_email**: Get a specific email by ID
  - Parameters: `emailId` (required)
- **send_email**: Send an email (supports threading via optional `inReplyTo` and `references` headers)
  - Parameters: `to` (required array), `cc` (optional array), `bcc` (optional array), `from` (optional), `mailboxId` (optional), `subject` (required), `textBody` (optional), `htmlBody` (optional), `inReplyTo` (optional array), `references` (optional array)
- **reply_email**: Reply to an existing email with proper threading headers (automatically builds In-Reply-To and References)
  - Parameters: `originalEmailId` (required), `to` (optional array, defaults to original sender), `cc` (optional array), `bcc` (optional array), `from` (optional), `textBody` (optional), `htmlBody` (optional)
- **save_draft**: Save an email as a draft without sending (supports threading headers for reply drafts)
  - Parameters: `to` (required array), `cc` (optional array), `bcc` (optional array), `from` (optional), `subject` (required), `textBody` (optional), `htmlBody` (optional), `inReplyTo` (optional array), `references` (optional array)
- **create_draft**: Create a minimal email draft (at least one of to/subject/body required)
  - Parameters: `to` (optional array), `cc` (optional array), `bcc` (optional array), `from` (optional), `mailboxId` (optional), `subject` (optional), `textBody` (optional), `htmlBody` (optional)
- **search_emails**: Search emails by content
  - Parameters: `query` (required), `limit` (default: 20), `offset` (default: 0)
- **get_recent_emails**: Get the most recent emails from a mailbox (inspired by JMAP-Samples top-ten)
  - Parameters: `limit` (default: 10, max: 50), `mailboxName` (default: 'inbox'), `offset` (default: 0)
- **mark_email_read**: Mark an email as read or unread
  - Parameters: `emailId` (required), `read` (default: true)
- **delete_email**: Delete an email (move to trash)
  - Parameters: `emailId` (required)
- **move_email**: Move an email to a different mailbox (replaces all mailboxes)
  - Parameters: `emailId` (required), `targetMailboxId` (required)
- **add_labels**: Add labels (mailboxes) to an email without removing existing ones
  - Parameters: `emailId` (required), `mailboxIds` (required array)
- **remove_labels**: Remove specific labels (mailboxes) from an email
  - Parameters: `emailId` (required), `mailboxIds` (required array)

### Advanced Email Features

- **get_email_attachments**: Get list of attachments for an email
  - Parameters: `emailId` (required)
- **download_attachment**: Download an email attachment. If savePath is provided, saves the file to disk and returns the file path and size. Otherwise returns a download URL.
  - Parameters: `emailId` (required), `attachmentId` (required), `savePath` (optional)
- **advanced_search**: Advanced email search with multiple criteria
  - Parameters: `query` (optional), `from` (optional), `to` (optional), `subject` (optional), `hasAttachment` (optional), `isUnread` (optional), `mailboxId` (optional), `after` (optional), `before` (optional), `limit` (default: 20), `offset` (default: 0)
- **get_thread**: Get all emails in a conversation thread
  - Parameters: `threadId` (required)

### Email Statistics & Analytics

- **get_mailbox_stats**: Get statistics for a mailbox (unread count, total emails, etc.)
  - Parameters: `mailboxId` (optional, defaults to all mailboxes)
- **get_account_summary**: Get overall account summary with statistics

### Bulk Operations

- **bulk_mark_read**: Mark multiple emails as read/unread
  - Parameters: `emailIds` (required array), `read` (default: true)
- **bulk_move**: Move multiple emails to a mailbox
  - Parameters: `emailIds` (required array), `targetMailboxId` (required)
- **bulk_delete**: Delete multiple emails (move to trash)
  - Parameters: `emailIds` (required array)
- **bulk_add_labels**: Add labels to multiple emails simultaneously
  - Parameters: `emailIds` (required array), `mailboxIds` (required array)
- **bulk_remove_labels**: Remove labels from multiple emails simultaneously
  - Parameters: `emailIds` (required array), `mailboxIds` (required array)

### Identity & Testing Tools

- **list_identities**: List sending identities (email addresses that can be used for sending)
- **check_function_availability**: Check which functions are available based on account permissions (includes setup guidance)
- **test_bulk_operations**: Safely test bulk operations with dry-run mode
  - Parameters: `dryRun` (default: true), `limit` (default: 3)

## API Information

This server uses the JMAP (JSON Meta Application Protocol) API provided by Fastmail. JMAP is a modern, efficient alternative to IMAP for email access.

### Inspired by Fastmail JMAP-Samples

Many features in this MCP server are inspired by the official [Fastmail JMAP-Samples](https://github.com/fastmail/JMAP-Samples) repository, including:
- Recent emails retrieval (based on top-ten example)
- Email management operations
- Efficient chained JMAP method calls

### Authentication
The server uses bearer token authentication with Fastmail's API. API tokens provide secure access without exposing your main account password.

### Rate Limits
Fastmail applies rate limits to API requests. The server handles standard rate limiting, but excessive requests may be throttled.

## Development

### Project Structure
```
src/
├── index.ts              # Startup entrypoint (stdio or HTTP mode)
├── mcp-server.ts         # MCP server factory and tool handlers
├── http-server.ts        # Streamable HTTP session management and limits
├── auth.ts              # Authentication handling
└── jmap-client.ts       # JMAP client wrapper with paginated email queries
```

### Building
```bash
npm run build
```

### Development Mode
```bash
npm run dev
```

## License

MIT

## Contributing

Contributions are welcome! Please ensure that:
1. Code follows the existing style
2. All functions are properly typed
3. Error handling is implemented
4. Documentation is updated for new features

## Troubleshooting

### Common Issues

1. **Authentication Errors**: Ensure your API token is valid and has the necessary permissions
2. **Missing Dependencies**: Run `npm install` to ensure all dependencies are installed  
3. **Build Errors**: Check that TypeScript compilation completes without errors using `npm run build`
4. **Unexpectedly Large Search Results**: Use `limit` and `offset`, then follow `next_offset` only when `has_more` is true
5. **HTTP Session Errors**: Prefer sessionless `POST` requests first; `mcp-session-id` is only needed for explicit stateful-session flows
6. **Too Many Concurrent Clients**: Increase `MCP_MAX_SESSIONS` or wait for idle sessions to expire if you are using explicit stateful sessions and the server returns "maximum concurrent MCP sessions reached"

### Email Tools Failing with Serialization Errors?

If `get_email`, `list_emails`, `search_emails`, or `advanced_search` fail with "content serialization" or "Cannot read properties of undefined" errors, upgrade to v1.7.1+. This was caused by incomplete JMAP response validation that surfaced after the MCP SDK v1.x upgrade added stricter result checking.

### Testing Your Setup

Use the built-in testing tools:
- **check_function_availability**: See what's available and get setup help
- **test_bulk_operations**: Safely test bulk operations without making changes

For more detailed error information, check the console output when running the server.

## Privacy & Security

- API tokens are stored encrypted by Claude Desktop when installed via the DXT and are never logged by this server.
- The server avoids logging raw errors and sensitive data (tokens, email addresses, identities, attachment names/blobIds) in error messages.
- Tool responses may include your email metadata/content by design (e.g., listing emails) but internal identifiers and credentials are not disclosed beyond what Fastmail returns for the requested data.
- If you encounter errors, messages are sanitized and summarized to prevent leaking personal information.
- In remote HTTP mode, this server is designed for a single shared Fastmail account, not for multi-tenant per-user isolation.
- Remote HTTP mode does not implement OAuth and does not rely on custom bearer-token auth from ChatGPT; secure it with a secret path and network/proxy controls appropriate for your deployment.
