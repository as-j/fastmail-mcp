import { createServer, IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, createRuntimeContext, McpClientContext } from './mcp-server.js';

export interface HttpSession {
  id?: string;
  readonly createdAt: number;
  lastSeenAt: number;
  reserved: boolean;
  closed: boolean;
  readonly server: { close(): Promise<void>; connect?(transport: unknown): Promise<void> };
  readonly transport: { sessionId?: string; close(): Promise<void>; handleRequest(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void>; onclose?: (() => void) | undefined };
  readonly context?: McpClientContext;
}

export interface HttpSessionManagerOptions {
  maxSessions: number;
  idleTtlMs: number;
}

export class HttpSessionManager {
  private readonly sessions = new Map<string, HttpSession>();
  private pendingReservations = 0;

  constructor(private readonly options: HttpSessionManagerOptions) {}

  tryReserve(): boolean {
    if (this.activeCount() >= this.options.maxSessions) return false;
    this.pendingReservations += 1;
    return true;
  }

  releaseReservation(): void {
    if (this.pendingReservations > 0) this.pendingReservations -= 1;
  }

  register(sessionId: string, session: HttpSession): void {
    session.id = sessionId;
    session.lastSeenAt = Date.now();
    if (session.reserved) {
      session.reserved = false;
      this.releaseReservation();
    }
    this.sessions.set(sessionId, session);
  }

  get(sessionId: string): HttpSession | undefined {
    return this.sessions.get(sessionId);
  }

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.lastSeenAt = Date.now();
  }

  async closeSession(session: HttpSession): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    if (session.id) this.sessions.delete(session.id);
    if (session.reserved) {
      session.reserved = false;
      this.releaseReservation();
    }
    await session.server.close();
  }

  async closeExpiredSessions(now = Date.now()): Promise<number> {
    const expired = [...this.sessions.values()].filter(
      (session) => now - session.lastSeenAt > this.options.idleTtlMs,
    );
    for (const session of expired) {
      await this.closeSession(session);
    }
    return expired.length;
  }

  async closeAll(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      await this.closeSession(session);
    }
    this.pendingReservations = 0;
  }

  size(): number {
    return this.sessions.size;
  }

  activeCount(): number {
    return this.sessions.size + this.pendingReservations;
  }
}

export interface HttpRuntimeOptions {
  mcpPath: string;
  port: number;
  maxSessions: number;
  idleTtlMs: number;
  reapIntervalMs: number;
  maxBodyBytes: number;
  env?: NodeJS.ProcessEnv;
  sessionFactory?: () => Promise<HttpSession>;
  logger?: (message: string) => void;
}

class RequestBodyTooLargeError extends Error {}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveHttpRuntimeOptions(
  env: NodeJS.ProcessEnv = process.env,
): HttpRuntimeOptions {
  const mcpPath = env.MCP_PATH?.trim();
  if (!mcpPath) {
    throw new Error('MCP_PATH is required for HTTP mode');
  }
  return {
    mcpPath,
    port: parsePositiveInt(env.PORT, 3000),
    maxSessions: parsePositiveInt(env.MCP_MAX_SESSIONS, 10),
    idleTtlMs: parsePositiveInt(env.MCP_SESSION_TTL_MS, 15 * 60 * 1000),
    reapIntervalMs: parsePositiveInt(env.MCP_REAP_INTERVAL_MS, 60 * 1000),
    maxBodyBytes: parsePositiveInt(env.MCP_MAX_BODY_BYTES, 1024 * 1024),
    env,
  };
}

function jsonRpcError(code: number, message: string, id: null = null) {
  return {
    jsonrpc: '2.0',
    error: { code, message },
    id,
  };
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  if (res.headersSent) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function maskSessionId(sessionId: string | undefined): string {
  if (!sessionId) return 'unknown';
  return sessionId.length <= 8 ? sessionId : `${sessionId.slice(0, 8)}...`;
}

async function readRequestBody(req: IncomingMessage, maxBodyBytes: number): Promise<string> {
  const contentLength = req.headers['content-length'];
  if (contentLength) {
    const parsedLength = Number.parseInt(Array.isArray(contentLength) ? contentLength[0] : contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > maxBodyBytes) {
      throw new RequestBodyTooLargeError(`Request body exceeds ${maxBodyBytes} bytes`);
    }
  }

  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        reject(new RequestBodyTooLargeError(`Request body exceeds ${maxBodyBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function getSessionIdHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers['mcp-session-id'];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

async function createDefaultSession(env: NodeJS.ProcessEnv = process.env): Promise<HttpSession> {
  const context = createRuntimeContext(env);
  const server = createMcpServer(context);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);
  return {
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    reserved: true,
    closed: false,
    server,
    transport,
    context,
  };
}

export function createHttpRequestHandler(
  options: HttpRuntimeOptions,
): { handler: RequestListener; sessionManager: HttpSessionManager } {
  const logger = options.logger ?? ((message: string) => console.error(message));
  const sessionManager = new HttpSessionManager({
    maxSessions: options.maxSessions,
    idleTtlMs: options.idleTtlMs,
  });
  const sessionFactory = options.sessionFactory ?? (() => createDefaultSession(options.env));

  const handler: RequestListener = async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${options.port}`);
    if (url.pathname !== `/${options.mcpPath}`) {
      res.writeHead(404).end();
      return;
    }

    let raw = '';
    try {
      raw = await readRequestBody(req, options.maxBodyBytes);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        logger(`Rejected oversized request on /${options.mcpPath}`);
        sendJson(res, 413, jsonRpcError(-32001, error.message));
        return;
      }
      sendJson(res, 400, jsonRpcError(-32700, 'Parse error'));
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = raw ? JSON.parse(raw) : undefined;
    } catch {
      sendJson(res, 400, jsonRpcError(-32700, 'Parse error'));
      return;
    }

    const sessionId = getSessionIdHeader(req);
    try {
      if (sessionId) {
        const session = sessionManager.get(sessionId);
        if (!session) {
          sendJson(res, 400, jsonRpcError(-32000, 'Bad Request: missing or invalid session'));
          return;
        }
        sessionManager.touch(sessionId);
        await session.transport.handleRequest(req, res, parsedBody);
        return;
      }

      if (req.method !== 'POST' || !isInitializeRequest(parsedBody)) {
        sendJson(res, 400, jsonRpcError(-32000, 'Bad Request: missing or invalid session'));
        return;
      }

      if (!sessionManager.tryReserve()) {
        logger(`Rejected initialize: session limit reached (${options.maxSessions})`);
        sendJson(res, 503, jsonRpcError(-32003, 'Server busy: maximum concurrent MCP sessions reached'));
        return;
      }

      const session = await sessionFactory();
      const originalOnClose = session.transport.onclose;
      session.transport.onclose = () => {
        originalOnClose?.();
        void sessionManager.closeSession(session);
      };

      if (session.transport instanceof StreamableHTTPServerTransport) {
        const originalHandleRequest = session.transport.handleRequest.bind(session.transport);
        session.transport.handleRequest = async (request, response, body) => {
          const before = session.transport.sessionId;
          await originalHandleRequest(request, response, body);
          const after = session.transport.sessionId;
          if (!before && after && !session.id) {
            sessionManager.register(after, session);
            logger(`Initialized MCP session ${maskSessionId(after)} (${sessionManager.size()} active)`);
          }
        };
      }

      try {
        await session.transport.handleRequest(req, res, parsedBody);
        const assignedSessionId = session.id ?? session.transport.sessionId;
        if (assignedSessionId && !sessionManager.get(assignedSessionId)) {
          sessionManager.register(assignedSessionId, session);
          logger(`Initialized MCP session ${maskSessionId(assignedSessionId)} (${sessionManager.size()} active)`);
        } else if (!assignedSessionId) {
          sessionManager.releaseReservation();
        }
      } catch (error) {
        sessionManager.releaseReservation();
        await session.server.close().catch(() => undefined);
        throw error;
      }
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, jsonRpcError(-32603, 'Internal server error'));
      }
    }
  };

  return { handler, sessionManager };
}

export async function runHttpServer(options: HttpRuntimeOptions): Promise<void> {
  const logger = options.logger ?? ((message: string) => console.error(message));
  const { handler, sessionManager } = createHttpRequestHandler(options);
  const httpServer = createServer(handler);

  const reaper = setInterval(async () => {
    const expired = await sessionManager.closeExpiredSessions();
    if (expired > 0) {
      logger(`Expired ${expired} idle MCP session${expired === 1 ? '' : 's'}`);
    }
  }, options.reapIntervalMs);
  reaper.unref();

  const shutdown = async () => {
    clearInterval(reaper);
    await sessionManager.closeAll();
    httpServer.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise<void>((resolve) => {
    httpServer.listen(options.port, () => {
      logger(
        `Fastmail MCP server running on HTTP port ${options.port} at /${options.mcpPath} ` +
        `(max sessions ${options.maxSessions}, idle TTL ${options.idleTtlMs}ms)`,
      );
      resolve();
    });
  });
}
