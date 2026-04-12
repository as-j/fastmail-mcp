import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { FastmailAuth, FastmailConfig } from './auth.js';
import { JmapClient, EmailAddress } from './jmap-client.js';
import { TOOL_DEFINITIONS } from './tool-definitions.js';

export const SERVER_INFO = {
  name: 'fastmail-mcp',
  version: '1.8.0',
} as const;

export interface McpClientContext {
  getMailClient(): JmapClient;
}

function normalizeAddresses(addrs: unknown): EmailAddress[] {
  let resolved: unknown = addrs;
  if (typeof resolved === 'string') {
    try {
      resolved = JSON.parse(resolved);
    } catch {
      return (resolved as string)
        .split(',')
        .map((s: string) => ({ email: s.trim() }))
        .filter((a: { email: string }) => a.email);
    }
  }
  if (!Array.isArray(resolved)) return [];
  return resolved.map((addr: unknown) => {
    if (typeof addr === 'string') return { email: addr };
    if (addr && typeof addr === 'object' && 'email' in addr) {
      return {
        email: (addr as Record<string, unknown>).email as string,
        name: ((addr as Record<string, unknown>).name ?? null) as string | null,
      };
    }
    throw new Error(`Invalid address format: ${JSON.stringify(addr)}`);
  });
}

function normalizeStringArray(val: unknown): string[] {
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Treat as a single value below.
    }
    return val.trim() ? [val.trim()] : [];
  }
  if (Array.isArray(val)) return val.map(String);
  return [];
}

function coerceArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value === 'string') {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

function findEnvValue(
  env: NodeJS.ProcessEnv,
  keys: string[],
): { value?: string; key?: string; wasPlaceholder: boolean } {
  const isPlaceholder = (val: string) => /\$\{[^}]+\}/.test(val.trim());
  for (const key of keys) {
    const raw = env[key];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      if (isPlaceholder(raw)) {
        return { value: undefined, key, wasPlaceholder: true };
      }
      return { value: raw.trim(), key, wasPlaceholder: false };
    }
  }
  return { value: undefined, key: undefined, wasPlaceholder: false };
}

function resolveFastmailConfig(env: NodeJS.ProcessEnv): FastmailConfig {
  const tokenInfo = findEnvValue(env, [
    'FASTMAIL_API_TOKEN',
    'USER_CONFIG_FASTMAIL_API_TOKEN',
    'USER_CONFIG_fastmail_api_token',
    'fastmail_api_token',
  ]);
  const apiToken = tokenInfo.value;
  if (!apiToken) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'FASTMAIL_API_TOKEN environment variable is required',
    );
  }

  const baseInfo = findEnvValue(env, [
    'FASTMAIL_BASE_URL',
    'USER_CONFIG_FASTMAIL_BASE_URL',
    'USER_CONFIG_fastmail_base_url',
    'fastmail_base_url',
  ]);

  return {
    apiToken,
    baseUrl: baseInfo.value,
  };
}

export class FastmailClientContext implements McpClientContext {
  private readonly env: NodeJS.ProcessEnv;
  private config: FastmailConfig | null = null;
  private jmapClient: JmapClient | null = null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  private getConfig(): FastmailConfig {
    if (!this.config) {
      this.config = resolveFastmailConfig(this.env);
    }
    return this.config;
  }

  getMailClient(): JmapClient {
    if (!this.jmapClient) {
      this.jmapClient = new JmapClient(new FastmailAuth(this.getConfig()));
    }
    return this.jmapClient;
  }
}

export function createRuntimeContext(env: NodeJS.ProcessEnv = process.env): McpClientContext {
  return new FastmailClientContext(env);
}

export function createMcpServer(context: McpClientContext): Server {
  const server = new Server(
    SERVER_INFO,
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = coerceArgs(request.params.arguments);

    try {
      const client = context.getMailClient();

      switch (name) {
        case 'list_mailboxes': {
          const mailboxes = await client.getMailboxes();
          return { content: [{ type: 'text', text: JSON.stringify(mailboxes, null, 2) }] };
        }
        case 'list_emails': {
          const { mailboxId, limit = 20, offset = 0 } = args as any;
          const emails = await client.getEmails(mailboxId, limit, offset);
          return { content: [{ type: 'text', text: JSON.stringify(emails, null, 2) }] };
        }
        case 'get_email': {
          const { emailId } = args as any;
          if (!emailId) throw new McpError(ErrorCode.InvalidParams, 'emailId is required');
          const email = await client.getEmailById(emailId);
          return { content: [{ type: 'text', text: JSON.stringify(email, null, 2) }] };
        }
        case 'send_email': {
          const { to, cc, bcc, from, mailboxId, subject, textBody, htmlBody, inReplyTo, references } = args as any;
          const toAddrs = normalizeAddresses(to);
          if (toAddrs.length === 0) throw new McpError(ErrorCode.InvalidParams, 'to field is required and must be a non-empty array');
          if (!subject) throw new McpError(ErrorCode.InvalidParams, 'subject is required');
          if (!textBody && !htmlBody) throw new McpError(ErrorCode.InvalidParams, 'Either textBody or htmlBody is required');
          const submissionId = await client.sendEmail({
            to: toAddrs,
            cc: cc ? normalizeAddresses(cc) : undefined,
            bcc: bcc ? normalizeAddresses(bcc) : undefined,
            from,
            mailboxId,
            subject,
            textBody,
            htmlBody,
            inReplyTo: Array.isArray(inReplyTo) ? inReplyTo : (inReplyTo ? [inReplyTo] : undefined),
            references: Array.isArray(references) ? references : (references ? [references] : undefined),
          });
          return { content: [{ type: 'text', text: `Email sent successfully. Submission ID: ${submissionId}` }] };
        }
        case 'reply_email': {
          const { originalEmailId, to, cc, bcc, from, textBody, htmlBody } = args as any;
          if (!originalEmailId) throw new McpError(ErrorCode.InvalidParams, 'originalEmailId is required');
          if (!textBody && !htmlBody) throw new McpError(ErrorCode.InvalidParams, 'Either textBody or htmlBody is required');
          const originalEmail = await client.getEmailById(originalEmailId);
          const originalMessageId = originalEmail.messageId?.[0];
          if (!originalMessageId) throw new McpError(ErrorCode.InternalError, 'Original email does not have a Message-ID; cannot thread reply');
          const referencesHeader = [...(originalEmail.references || []), originalMessageId];
          let replySubject = originalEmail.subject || '';
          if (!/^Re:/i.test(replySubject)) replySubject = `Re: ${replySubject}`;
          const normalizedTo = to ? normalizeAddresses(to) : [];
          const replyTo = normalizedTo.length > 0
            ? normalizedTo
            : (originalEmail.from?.map((addr: any) => ({ email: addr.email, name: addr.name ?? null })).filter((a: any) => a.email) || []);
          if (replyTo.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, 'Could not determine reply recipient. Please provide "to" explicitly.');
          }
          const submissionId = await client.sendEmail({
            to: replyTo,
            cc: cc ? normalizeAddresses(cc) : undefined,
            bcc: bcc ? normalizeAddresses(bcc) : undefined,
            from,
            subject: replySubject,
            textBody,
            htmlBody,
            inReplyTo: [originalMessageId],
            references: referencesHeader,
          });
          return { content: [{ type: 'text', text: `Reply sent successfully. Submission ID: ${submissionId}` }] };
        }
        case 'save_draft': {
          const { to, cc, bcc, from, subject, textBody, htmlBody, inReplyTo, references } = args as any;
          const toAddrs = normalizeAddresses(to);
          if (toAddrs.length === 0) throw new McpError(ErrorCode.InvalidParams, 'to field is required and must be a non-empty array');
          if (!subject) throw new McpError(ErrorCode.InvalidParams, 'subject is required');
          if (!textBody && !htmlBody) throw new McpError(ErrorCode.InvalidParams, 'Either textBody or htmlBody is required');
          const draftId = await client.saveDraft({
            to: toAddrs,
            cc: cc ? normalizeAddresses(cc) : undefined,
            bcc: bcc ? normalizeAddresses(bcc) : undefined,
            from,
            subject,
            textBody,
            htmlBody,
            inReplyTo: Array.isArray(inReplyTo) ? inReplyTo : (inReplyTo ? [inReplyTo] : undefined),
            references: Array.isArray(references) ? references : (references ? [references] : undefined),
          });
          return { content: [{ type: 'text', text: `Draft saved successfully. Draft ID: ${draftId}` }] };
        }
        case 'create_draft': {
          const { to, cc, bcc, from, mailboxId, subject, textBody, htmlBody } = args as any;
          if (!to?.length && !subject && !textBody && !htmlBody) {
            throw new McpError(ErrorCode.InvalidParams, 'At least one of to, subject, textBody, or htmlBody must be provided');
          }
          const emailId = await client.createDraft({
            to: to ? normalizeAddresses(to) : undefined,
            cc: cc ? normalizeAddresses(cc) : undefined,
            bcc: bcc ? normalizeAddresses(bcc) : undefined,
            from,
            mailboxId,
            subject,
            textBody,
            htmlBody,
          });
          return { content: [{ type: 'text', text: `Draft created successfully. Email ID: ${emailId}` }] };
        }
        case 'search_emails': {
          const { query, limit = 20, offset = 0 } = args as any;
          if (!query) throw new McpError(ErrorCode.InvalidParams, 'query is required');
          const emails = await client.searchEmails(query, limit, offset);
          return { content: [{ type: 'text', text: JSON.stringify(emails, null, 2) }] };
        }
        case 'list_identities': {
          const identities = await client.getIdentities();
          return { content: [{ type: 'text', text: JSON.stringify(identities, null, 2) }] };
        }
        case 'get_recent_emails': {
          const { limit = 10, mailboxName = 'inbox', offset = 0 } = args as any;
          const emails = await client.getRecentEmails(limit, mailboxName, offset);
          return { content: [{ type: 'text', text: JSON.stringify(emails, null, 2) }] };
        }
        case 'mark_email_read': {
          const { emailId, read = true } = args as any;
          if (!emailId) throw new McpError(ErrorCode.InvalidParams, 'emailId is required');
          await client.markEmailRead(emailId, read);
          return { content: [{ type: 'text', text: `Email ${read ? 'marked as read' : 'marked as unread'} successfully` }] };
        }
        case 'delete_email': {
          const { emailId } = args as any;
          if (!emailId) throw new McpError(ErrorCode.InvalidParams, 'emailId is required');
          await client.deleteEmail(emailId);
          return { content: [{ type: 'text', text: 'Email deleted successfully (moved to trash)' }] };
        }
        case 'move_email': {
          const { emailId, targetMailboxId } = args as any;
          if (!emailId || !targetMailboxId) throw new McpError(ErrorCode.InvalidParams, 'emailId and targetMailboxId are required');
          await client.moveEmail(emailId, targetMailboxId);
          return { content: [{ type: 'text', text: 'Email moved successfully' }] };
        }
        case 'add_labels': {
          const { emailId, mailboxIds: rawMailboxIds } = args as any;
          if (!emailId) throw new McpError(ErrorCode.InvalidParams, 'emailId is required');
          const mailboxIds = normalizeStringArray(rawMailboxIds);
          if (mailboxIds.length === 0) throw new McpError(ErrorCode.InvalidParams, 'mailboxIds array is required and must not be empty');
          await client.addLabels(emailId, mailboxIds);
          return { content: [{ type: 'text', text: 'Labels added successfully to email' }] };
        }
        case 'remove_labels': {
          const { emailId, mailboxIds: rawMailboxIds } = args as any;
          if (!emailId) throw new McpError(ErrorCode.InvalidParams, 'emailId is required');
          const mailboxIds = normalizeStringArray(rawMailboxIds);
          if (mailboxIds.length === 0) throw new McpError(ErrorCode.InvalidParams, 'mailboxIds array is required and must not be empty');
          await client.removeLabels(emailId, mailboxIds);
          return { content: [{ type: 'text', text: 'Labels removed successfully from email' }] };
        }
        case 'get_email_attachments': {
          const { emailId } = args as any;
          if (!emailId) throw new McpError(ErrorCode.InvalidParams, 'emailId is required');
          const attachments = await client.getEmailAttachments(emailId);
          return { content: [{ type: 'text', text: JSON.stringify(attachments, null, 2) }] };
        }
        case 'download_attachment': {
          const { emailId, attachmentId, savePath } = args as any;
          if (!emailId || !attachmentId) throw new McpError(ErrorCode.InvalidParams, 'emailId and attachmentId are required');
          try {
            if (savePath) {
              const result = await client.downloadAttachmentToFile(emailId, attachmentId, savePath);
              return { content: [{ type: 'text', text: `Saved to: ${savePath} (${result.bytesWritten} bytes)` }] };
            }
            const downloadUrl = await client.downloadAttachment(emailId, attachmentId);
            return { content: [{ type: 'text', text: `Download URL: ${downloadUrl}` }] };
          } catch {
            throw new McpError(
              ErrorCode.InternalError,
              'Attachment download failed. Verify emailId and attachmentId and try again.',
            );
          }
        }
        case 'advanced_search': {
          const { query, from, to, subject, hasAttachment, isUnread, mailboxId, after, before, limit, offset } = args as any;
          const emails = await client.advancedSearch({ query, from, to, subject, hasAttachment, isUnread, mailboxId, after, before, limit, offset });
          return { content: [{ type: 'text', text: JSON.stringify(emails, null, 2) }] };
        }
        case 'get_thread': {
          const { threadId } = args as any;
          if (!threadId) throw new McpError(ErrorCode.InvalidParams, 'threadId is required');
          try {
            const thread = await client.getThread(threadId);
            return { content: [{ type: 'text', text: JSON.stringify(thread, null, 2) }] };
          } catch (error) {
            throw new McpError(ErrorCode.InternalError, `Thread access failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        case 'get_mailbox_stats': {
          const { mailboxId } = args as any;
          const stats = await client.getMailboxStats(mailboxId);
          return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
        }
        case 'get_account_summary': {
          const summary = await client.getAccountSummary();
          return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
        }
        case 'bulk_mark_read': {
          const { emailIds: rawEmailIds, read = true } = args as any;
          const emailIds = normalizeStringArray(rawEmailIds);
          if (emailIds.length === 0) throw new McpError(ErrorCode.InvalidParams, 'emailIds array is required and must not be empty');
          await client.bulkMarkRead(emailIds, read);
          return { content: [{ type: 'text', text: `${emailIds.length} emails ${read ? 'marked as read' : 'marked as unread'} successfully` }] };
        }
        case 'bulk_move': {
          const { emailIds: rawEmailIdsBM, targetMailboxId } = args as any;
          const emailIds = normalizeStringArray(rawEmailIdsBM);
          if (emailIds.length === 0) throw new McpError(ErrorCode.InvalidParams, 'emailIds array is required and must not be empty');
          if (!targetMailboxId) throw new McpError(ErrorCode.InvalidParams, 'targetMailboxId is required');
          await client.bulkMove(emailIds, targetMailboxId);
          return { content: [{ type: 'text', text: `${emailIds.length} emails moved successfully` }] };
        }
        case 'bulk_delete': {
          const { emailIds: rawEmailIdsBD } = args as any;
          const emailIds = normalizeStringArray(rawEmailIdsBD);
          if (emailIds.length === 0) throw new McpError(ErrorCode.InvalidParams, 'emailIds array is required and must not be empty');
          await client.bulkDelete(emailIds);
          return { content: [{ type: 'text', text: `${emailIds.length} emails deleted successfully (moved to trash)` }] };
        }
        case 'bulk_add_labels': {
          const { emailIds: rawEmailIdsBAL, mailboxIds: rawMailboxIdsBAL } = args as any;
          const emailIds = normalizeStringArray(rawEmailIdsBAL);
          const mailboxIds = normalizeStringArray(rawMailboxIdsBAL);
          if (emailIds.length === 0) throw new McpError(ErrorCode.InvalidParams, 'emailIds array is required and must not be empty');
          if (mailboxIds.length === 0) throw new McpError(ErrorCode.InvalidParams, 'mailboxIds array is required and must not be empty');
          await client.bulkAddLabels(emailIds, mailboxIds);
          return { content: [{ type: 'text', text: `Labels added successfully to ${emailIds.length} emails` }] };
        }
        case 'bulk_remove_labels': {
          const { emailIds: rawEmailIdsBRL, mailboxIds: rawMailboxIdsBRL } = args as any;
          const emailIds = normalizeStringArray(rawEmailIdsBRL);
          const mailboxIds = normalizeStringArray(rawMailboxIdsBRL);
          if (emailIds.length === 0) throw new McpError(ErrorCode.InvalidParams, 'emailIds array is required and must not be empty');
          if (mailboxIds.length === 0) throw new McpError(ErrorCode.InvalidParams, 'mailboxIds array is required and must not be empty');
          await client.bulkRemoveLabels(emailIds, mailboxIds);
          return { content: [{ type: 'text', text: `Labels removed successfully from ${emailIds.length} emails` }] };
        }
        case 'check_function_availability': {
          const session = await client.getSession();
          const availability = {
            email: {
              available: true,
              functions: [
                'list_mailboxes', 'list_emails', 'get_email', 'send_email', 'create_draft', 'search_emails',
                'get_recent_emails', 'mark_email_read', 'delete_email', 'move_email',
                'get_email_attachments', 'download_attachment', 'advanced_search', 'get_thread',
                'get_mailbox_stats', 'get_account_summary', 'bulk_mark_read', 'bulk_move', 'bulk_delete',
                'add_labels', 'remove_labels', 'bulk_add_labels', 'bulk_remove_labels',
              ],
            },
            identity: {
              available: true,
              functions: ['list_identities'],
            },
            capabilities: Object.keys(session.capabilities),
          };
          return { content: [{ type: 'text', text: JSON.stringify(availability, null, 2) }] };
        }
        case 'test_bulk_operations': {
          const { dryRun = true, limit = 3 } = args as any;
          const testLimit = Math.min(Math.max(limit, 1), 10);
          const emails = await client.getRecentEmails(testLimit, 'inbox');
          if (emails.items.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'No emails found for bulk operation testing. Try sending yourself a test email first.',
                },
              ],
            };
          }
          const emailIds = emails.items.slice(0, testLimit).map((email) => email.id);
          const operations = [
            {
              name: 'bulk_mark_read',
              description: `Mark ${emailIds.length} emails as read`,
              parameters: { emailIds, read: true },
            },
            {
              name: 'bulk_mark_read (undo)',
              description: `Mark ${emailIds.length} emails as unread (undo previous)`,
              parameters: { emailIds, read: false },
            },
          ];
          const results = {
            testEmails: emails.items.map((email) => ({
              id: email.id,
              subject: email.subject,
              from: email.from?.[0]?.email || 'unknown',
              receivedAt: email.receivedAt,
            })),
            operations: [] as any[],
          };
          if (dryRun) {
            results.operations = operations.map((op) => ({
              ...op,
              status: 'DRY RUN - Would execute but not actually performed',
              executed: false,
            }));
            return {
              content: [
                {
                  type: 'text',
                  text: `BULK OPERATIONS TEST (DRY RUN)\n\n${JSON.stringify(results, null, 2)}\n\nTo actually execute the test, set dryRun: false`,
                },
              ],
            };
          }
          for (const operation of operations) {
            try {
              await client.bulkMarkRead(operation.parameters.emailIds, operation.parameters.read);
              results.operations.push({
                ...operation,
                status: 'SUCCESS',
                executed: true,
                timestamp: new Date().toISOString(),
              });
              await new Promise((resolve) => setTimeout(resolve, 500));
            } catch (error) {
              results.operations.push({
                ...operation,
                status: 'FAILED',
                executed: false,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString(),
              });
            }
          }
          return {
            content: [
              {
                type: 'text',
                text: `BULK OPERATIONS TEST (EXECUTED)\n\n${JSON.stringify(results, null, 2)}`,
              },
            ],
          };
        }
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(
        ErrorCode.InternalError,
        `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  return server;
}
