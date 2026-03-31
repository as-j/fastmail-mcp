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
    assert.equal(first.getContactsCalendarClient(), first.getContactsCalendarClient());
    assert.notEqual(first.getMailClient(), second.getMailClient());
    assert.notEqual(first.getContactsCalendarClient(), second.getContactsCalendarClient());
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

  it('routes multiple clients to distinct sessions and preserves live sessions after one closes', async () => {
    let sessionCounter = 0;
    const { handler, sessionManager } = createHttpRequestHandler({
      mcpPath: 'supersecretpath',
      port: 0,
      maxSessions: 5,
      idleTtlMs: 60_000,
      reapIntervalMs: 60_000,
      maxBodyBytes: 1024,
      sessionFactory: async () => {
        sessionCounter += 1;
        return createFakeSession(`sid-${sessionCounter}`, `session-${sessionCounter}`);
      },
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

    const initOne = await fetch(baseUrl, { method: 'POST', body: initializeBody, headers: { 'Content-Type': 'application/json' } });
    const sessionOne = initOne.headers.get('mcp-session-id');
    assert.equal(sessionOne, 'sid-1');

    const initTwo = await fetch(baseUrl, { method: 'POST', body: initializeBody, headers: { 'Content-Type': 'application/json' } });
    const sessionTwo = initTwo.headers.get('mcp-session-id');
    assert.equal(sessionTwo, 'sid-2');

    const callOne = await fetch(baseUrl, { method: 'POST', headers: { 'mcp-session-id': sessionOne! } });
    assert.deepEqual(await callOne.json(), { label: 'session-1' });

    const closeOne = sessionManager.get(sessionOne!);
    await sessionManager.closeSession(closeOne!);

    const callTwo = await fetch(baseUrl, { method: 'POST', headers: { 'mcp-session-id': sessionTwo! } });
    assert.deepEqual(await callTwo.json(), { label: 'session-2' });
  });

  it('returns JSON-RPC errors for invalid sessions, oversized bodies, and capacity limits', async () => {
    const { handler } = createHttpRequestHandler({
      mcpPath: 'supersecretpath',
      port: 0,
      maxSessions: 1,
      idleTtlMs: 60_000,
      reapIntervalMs: 60_000,
      maxBodyBytes: 256,
      sessionFactory: async () => createFakeSession('sid-1', 'session-1'),
      logger: () => undefined,
    });
    const server = await startServer(handler);
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.port}/supersecretpath`;

    const missing = await fetch(baseUrl, { method: 'POST' });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.message, 'Bad Request: missing or invalid session');

    const oversized = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: 'x'.repeat(1000) }),
    });
    assert.equal(oversized.status, 413);

    const initializeBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
    });
    const first = await fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: initializeBody });
    assert.equal(first.status, 200);

    const second = await fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: initializeBody });
    assert.equal(second.status, 503);
    assert.equal((await second.json()).error.message, 'Server busy: maximum concurrent MCP sessions reached');
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
