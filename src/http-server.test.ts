import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  createHttpRequestHandler,
  HttpSession,
  HttpSessionManager,
} from './http-server.js';
import { FastmailClientContext } from './mcp-server.js';

async function startServer(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    server,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function createFakeSession(id: string, label: string): HttpSession {
  const close = mock.fn(async () => undefined);
  const transport = {
    sessionId: id,
    onclose: undefined as (() => void) | undefined,
    async close() {
      transport.onclose?.();
    },
    async handleRequest(_req: any, res: any) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'mcp-session-id': id,
      });
      res.end(JSON.stringify({ label }));
    },
  };
  return {
    id,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    reserved: true,
    closed: false,
    server: { close },
    transport,
  };
}

describe('FastmailClientContext', () => {
  const env = {
    FASTMAIL_API_TOKEN: 'token-123',
    FASTMAIL_BASE_URL: 'https://api.fastmail.com',
  } as NodeJS.ProcessEnv;

  it('caches clients per context but not across contexts', () => {
    const first = new FastmailClientContext(env);
    const second = new FastmailClientContext(env);

    assert.equal(first.getMailClient(), first.getMailClient());
    assert.notEqual(first.getMailClient(), second.getMailClient());
  });
});

describe('HttpSessionManager', () => {
  it('enforces capacity across reservations and active sessions', () => {
    const manager = new HttpSessionManager({ maxSessions: 1, idleTtlMs: 1000 });
    assert.equal(manager.tryReserve(), true);
    assert.equal(manager.tryReserve(), false);
  });

  it('closes expired sessions and leaves fresh ones alone', async () => {
    const manager = new HttpSessionManager({ maxSessions: 5, idleTtlMs: 50 });
    const stale = createFakeSession('stale', 'stale');
    stale.reserved = false;
    const fresh = createFakeSession('fresh', 'fresh');
    fresh.reserved = false;
    manager.register('stale', stale);
    manager.register('fresh', fresh);
    stale.lastSeenAt = Date.now() - 500;
    fresh.lastSeenAt = Date.now();

    const expired = await manager.closeExpiredSessions(Date.now());
    assert.equal(expired, 1);
    assert.equal(manager.get('stale'), undefined);
    assert.ok(manager.get('fresh'));
  });
});

describe('createHttpRequestHandler', () => {
  let servers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers = [];
    mock.restoreAll();
  });

  it('handles repeated sessionless initialize requests without consuming session slots', async () => {
    const { handler, sessionManager } = createHttpRequestHandler({
      mcpPath: 'supersecretpath',
      port: 0,
      maxSessions: 5,
      idleTtlMs: 60_000,
      reapIntervalMs: 60_000,
      maxBodyBytes: 1024,
      logger: () => undefined,
    });
    const server = await startServer(handler);
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.port}/supersecretpath`;
    const initializeBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
    });

    const initOne = await fetch(baseUrl, { method: 'POST', body: initializeBody, headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' } });
    assert.equal(initOne.status, 200);
    assert.equal(initOne.headers.get('mcp-session-id'), null);
    assert.equal(sessionManager.size(), 0);

    const initTwo = await fetch(baseUrl, { method: 'POST', body: initializeBody, headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' } });
    assert.equal(initTwo.status, 200);
    assert.equal(initTwo.headers.get('mcp-session-id'), null);
    assert.equal(sessionManager.size(), 0);
  });

  it('supports sessionless tools/list after sessionless initialize', async () => {
    const { handler } = createHttpRequestHandler({
      mcpPath: 'supersecretpath',
      port: 0,
      maxSessions: 1,
      idleTtlMs: 60_000,
      reapIntervalMs: 60_000,
      maxBodyBytes: 2048,
      logger: () => undefined,
    });
    const server = await startServer(handler);
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.port}/supersecretpath`;

    const initializeBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
    });
    const init = await fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' }, body: initializeBody });
    assert.equal(init.status, 200);

    const toolsList = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal(toolsList.status, 200);
    const toolsListJson = await toolsList.json() as { result?: { tools?: unknown[] } };
    assert.ok(Array.isArray(toolsListJson.result?.tools));
  });

  it('returns JSON-RPC errors for invalid sessions and oversized bodies', async () => {
    const { handler } = createHttpRequestHandler({
      mcpPath: 'supersecretpath',
      port: 0,
      maxSessions: 1,
      idleTtlMs: 60_000,
      reapIntervalMs: 60_000,
      maxBodyBytes: 256,
      logger: () => undefined,
    });
    const server = await startServer(handler);
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.port}/supersecretpath`;

    const invalidSession = await fetch(baseUrl, { method: 'POST', headers: { 'mcp-session-id': 'missing-session' } });
    assert.equal(invalidSession.status, 400);
    assert.equal((await invalidSession.json()).error.message, 'Bad Request: missing or invalid session');

    const oversized = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ payload: 'x'.repeat(1000) }),
    });
    assert.equal(oversized.status, 413);
  });

  it('preserves explicit stateful sessions when a valid session id is supplied', async () => {
    const { handler, sessionManager } = createHttpRequestHandler({
      mcpPath: 'supersecretpath',
      port: 0,
      maxSessions: 2,
      idleTtlMs: 60_000,
      reapIntervalMs: 60_000,
      maxBodyBytes: 1024,
      logger: () => undefined,
    });
    const firstSession = createFakeSession('sid-1', 'session-1');
    firstSession.reserved = false;
    const secondSession = createFakeSession('sid-2', 'session-2');
    secondSession.reserved = false;
    sessionManager.register('sid-1', firstSession);
    sessionManager.register('sid-2', secondSession);

    const server = await startServer(handler);
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.port}/supersecretpath`;

    const callOne = await fetch(baseUrl, { method: 'POST', headers: { 'mcp-session-id': 'sid-1' } });
    assert.deepEqual(await callOne.json(), { label: 'session-1' });

    await sessionManager.closeSession(firstSession);

    const callTwo = await fetch(baseUrl, { method: 'POST', headers: { 'mcp-session-id': 'sid-2' } });
    assert.deepEqual(await callTwo.json(), { label: 'session-2' });
  });

  it('expires idle sessions during reap', async () => {
    const fakeSession = createFakeSession('sid-expire', 'session-expire');
    const { sessionManager } = createHttpRequestHandler({
      mcpPath: 'supersecretpath',
      port: 0,
      maxSessions: 2,
      idleTtlMs: 5,
      reapIntervalMs: 60_000,
      maxBodyBytes: 1024,
      sessionFactory: async () => fakeSession,
      logger: () => undefined,
    });

    sessionManager.register('sid-expire', fakeSession);
    fakeSession.lastSeenAt = Date.now() - 10_000;
    const expired = await sessionManager.closeExpiredSessions(Date.now());

    assert.equal(expired, 1);
    assert.equal(sessionManager.get('sid-expire'), undefined);
  });
});
