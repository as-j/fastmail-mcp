#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, createRuntimeContext } from './mcp-server.js';
import { resolveHttpRuntimeOptions, runHttpServer } from './http-server.js';

export async function runStdio(): Promise<void> {
  const server = createMcpServer(createRuntimeContext(process.env));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Fastmail MCP server running on stdio');
}

async function main(): Promise<void> {
  const mcpPath = process.env.MCP_PATH?.trim();
  if (mcpPath) {
    if (mcpPath.length < 8) {
      console.error('MCP_PATH must be at least 8 characters');
      process.exit(1);
    }
    await runHttpServer(resolveHttpRuntimeOptions(process.env));
    return;
  }
  await runStdio();
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch(() => {
    const isHttpMode = !!process.env.MCP_PATH?.trim();
    console.error(isHttpMode ? 'Fastmail MCP HTTP server failed to start' : 'Fastmail MCP server failed to start');
    process.exit(1);
  });
}
