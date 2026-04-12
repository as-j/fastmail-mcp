interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

function description(...lines: string[]): string {
  return lines.join('\n');
}

function defineTool(
  name: string,
  title: string,
  details: string,
  inputSchema: ToolInputSchema,
  annotations: ToolDefinition['annotations'],
): ToolDefinition {
  return {
    name,
    description: details,
    inputSchema,
    annotations,
  };
}

function readTool(
  name: string,
  title: string,
  details: string,
  inputSchema: ToolInputSchema,
): ToolDefinition {
  return defineTool(name, title, details, inputSchema, {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
}

function writeTool(
  name: string,
  title: string,
  details: string,
  inputSchema: ToolInputSchema,
  options: { destructiveHint?: boolean; idempotentHint?: boolean } = {},
): ToolDefinition {
  return defineTool(name, title, details, inputSchema, {
    title,
    readOnlyHint: false,
    destructiveHint: options.destructiveHint ?? false,
    idempotentHint: options.idempotentHint ?? false,
    openWorldHint: true,
  });
}

const emptySchema: ToolInputSchema = {
  type: 'object',
  properties: {},
};

const addressObject = {
  type: 'object',
  properties: {
    email: { type: 'string' },
    name: { type: 'string' },
  },
  required: ['email'],
};

const addressListSchema = {
  anyOf: [
    {
      type: 'array',
      items: addressObject,
    },
    { type: 'string' },
  ],
};

const stringArraySchema = {
  anyOf: [
    { type: 'array', items: { type: 'string' } },
    { type: 'string' },
  ],
};

const numberLikeSchema = {
  anyOf: [{ type: 'number' }, { type: 'string' }],
};

const booleanLikeSchema = {
  anyOf: [{ type: 'boolean' }, { type: 'string' }],
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  readTool(
    'list_mailboxes',
    'List Mailboxes',
    description(
      'List the mailboxes, folders, and label IDs in the connected Fastmail account.',
      'Use when the user wants mailbox names, wants to choose a destination for moving or labeling email, or asks what folders exist.',
      'Do not use when the user wants recent messages or inbox contents; use get_recent_emails, list_emails, or search_emails instead.',
    ),
    emptySchema,
  ),
  readTool(
    'list_emails',
    'List Emails',
    description(
      'List email summaries from one Fastmail mailbox or across the account in paginated form.',
      'Use when you already know the mailboxId and want to browse messages there, such as "show messages in Archive" or "list emails in Projects".',
      'Returns an object with items, total, has_more, and next_offset so the caller can continue paging without fetching everything at once.',
      'Do not use for "check email" or "read my inbox" when no mailbox is specified; use get_recent_emails instead. Do not use when you already have an emailId; use get_email.',
    ),
    {
      type: 'object',
      properties: {
        mailboxId: {
          type: 'string',
          description: 'ID of the mailbox to list emails from (optional, defaults to all)',
        },
        limit: {
          ...numberLikeSchema,
          description: 'Maximum number of emails to return (default: 20)',
          default: 20,
        },
        offset: {
          ...numberLikeSchema,
          description: 'Zero-based offset for pagination. Use next_offset from the previous response to fetch the next page.',
          default: 0,
        },
      },
    },
  ),
  readTool(
    'get_email',
    'Get Email',
    description(
      'Get one specific email by ID, including full content and metadata.',
      'Use after get_recent_emails, list_emails, search_emails, or advanced_search when you need to read the body, inspect headers, or prepare a reply.',
      'Do not use for browsing or discovery; use get_recent_emails or search tools first.',
    ),
    {
      type: 'object',
      properties: {
        emailId: {
          type: 'string',
          description: 'ID of the email to retrieve',
        },
      },
      required: ['emailId'],
    },
  ),
  writeTool(
    'send_email',
    'Send Email',
    description(
      'Send a new outbound email from the connected Fastmail account.',
      'Use when the user says things like "send email to Alice" or wants to compose a fresh message right now.',
      'Do not use for threaded replies; use reply_email. Do not use when the user wants to save a draft instead of sending; use save_draft or create_draft.',
    ),
    {
      type: 'object',
      properties: {
        to: {
          ...addressListSchema,
          description: 'Recipient addresses as [{email, name?}] objects',
        },
        cc: {
          ...addressListSchema,
          description: 'CC addresses (optional)',
        },
        bcc: {
          ...addressListSchema,
          description: 'BCC addresses (optional)',
        },
        from: {
          type: 'string',
          description: 'Sender email address (optional, defaults to account primary email)',
        },
        mailboxId: {
          type: 'string',
          description: 'Mailbox ID to save the email to (optional, defaults to Drafts folder)',
        },
        subject: {
          type: 'string',
          description: 'Email subject',
        },
        textBody: {
          type: 'string',
          description: 'Plain text body (optional)',
        },
        htmlBody: {
          type: 'string',
          description: 'HTML body (optional)',
        },
        inReplyTo: {
          ...stringArraySchema,
          description: 'Message-ID(s) of the email being replied to (optional, for threading)',
        },
        references: {
          ...stringArraySchema,
          description: 'Full reference chain of Message-IDs (optional, for threading)',
        },
      },
      required: ['to', 'subject'],
    },
  ),
  writeTool(
    'reply_email',
    'Reply to Email',
    description(
      'Reply to an existing email with Fastmail threading headers preserved automatically.',
      'Use when the user says "reply to this email", "answer the latest message from Alice", or wants a proper threaded response.',
      'Do not use for a brand-new outbound message; use send_email. Do not use when you only want to save a reply draft; use save_draft.',
    ),
    {
      type: 'object',
      properties: {
        originalEmailId: {
          type: 'string',
          description: 'ID of the email to reply to',
        },
        to: {
          ...addressListSchema,
          description: 'Recipient addresses as [{email, name?}] objects (optional, defaults to original sender)',
        },
        cc: {
          ...addressListSchema,
          description: 'CC addresses (optional)',
        },
        bcc: {
          ...addressListSchema,
          description: 'BCC addresses (optional)',
        },
        from: {
          type: 'string',
          description: 'Sender email address (optional, defaults to account primary email)',
        },
        textBody: {
          type: 'string',
          description: 'Plain text body (optional)',
        },
        htmlBody: {
          type: 'string',
          description: 'HTML body (optional)',
        },
      },
      required: ['originalEmailId'],
    },
  ),
  writeTool(
    'save_draft',
    'Save Draft',
    description(
      'Save an unsent draft email in Fastmail, including reply-thread headers when provided.',
      'Use when the user says "save a draft", "draft a reply", or wants a message prepared without sending it yet.',
      'Do not use for immediate delivery; use send_email. Do not use for a minimal placeholder draft with only partial fields; use create_draft.',
    ),
    {
      type: 'object',
      properties: {
        to: {
          ...addressListSchema,
          description: 'Recipient addresses as [{email, name?}] objects',
        },
        cc: {
          ...addressListSchema,
          description: 'CC addresses (optional)',
        },
        bcc: {
          ...addressListSchema,
          description: 'BCC addresses (optional)',
        },
        from: {
          type: 'string',
          description: 'Sender email address (optional, defaults to account primary email)',
        },
        subject: {
          type: 'string',
          description: 'Email subject',
        },
        textBody: {
          type: 'string',
          description: 'Plain text body (optional)',
        },
        htmlBody: {
          type: 'string',
          description: 'HTML body (optional)',
        },
        inReplyTo: {
          ...stringArraySchema,
          description: 'Message-IDs to reply to (optional, for threading)',
        },
        references: {
          ...stringArraySchema,
          description: 'Message-IDs for References header (optional, for threading)',
        },
      },
      required: ['to', 'subject'],
    },
  ),
  writeTool(
    'create_draft',
    'Create Draft',
    description(
      'Create a minimal draft email record without sending it.',
      'Use when the user wants a placeholder draft or partial draft state, such as saving a subject/body before the message is complete.',
      'Do not use for threaded replies or a send-ready draft reply; use save_draft or reply_email.',
    ),
    {
      type: 'object',
      properties: {
        to: {
          ...addressListSchema,
          description: 'Recipient addresses as [{email, name?}] objects (optional)',
        },
        cc: {
          ...addressListSchema,
          description: 'CC addresses (optional)',
        },
        bcc: {
          ...addressListSchema,
          description: 'BCC addresses (optional)',
        },
        from: {
          type: 'string',
          description: 'Sender email address (optional, defaults to account primary email)',
        },
        mailboxId: {
          type: 'string',
          description: 'Mailbox ID to save the draft to (optional, defaults to Drafts folder)',
        },
        subject: {
          type: 'string',
          description: 'Email subject (optional)',
        },
        textBody: {
          type: 'string',
          description: 'Plain text body (optional)',
        },
        htmlBody: {
          type: 'string',
          description: 'HTML body (optional)',
        },
      },
    },
  ),
  readTool(
    'search_emails',
    'Search Emails',
    description(
      'Search Fastmail email by free-text query across subject and message content in paginated form.',
      'Use when the user wants to find email about a topic or phrase, such as "search for invoices" or "find messages about taxes".',
      'Returns items, total, has_more, and next_offset so the agent can stop after the first useful page instead of pulling a large result set.',
      'Do not use for "check email" or "show recent emails"; use get_recent_emails. Do not use when you need structured filters like sender, unread, attachments, or date range; use advanced_search.',
    ),
    {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query string',
        },
        limit: {
          ...numberLikeSchema,
          description: 'Maximum number of results (default: 20)',
          default: 20,
        },
        offset: {
          ...numberLikeSchema,
          description: 'Zero-based offset for pagination. Use next_offset from the previous response to fetch the next page.',
          default: 0,
        },
      },
      required: ['query'],
    },
  ),
  readTool(
    'list_identities',
    'List Sending Identities',
    description(
      'List Fastmail sending identities that can be used in the from field.',
      'Use before send_email, save_draft, or create_draft when the user wants to send from an alias or confirm which sender addresses are allowed.',
      'Do not use for inbox or message retrieval.',
    ),
    emptySchema,
  ),
  readTool(
    'get_recent_emails',
    'Get Recent Emails',
    description(
      'Get the newest email summaries from a Fastmail mailbox, defaulting to Inbox, in paginated form.',
      'Use when the user says "check email", "read my inbox", "show recent emails", or asks what just arrived.',
      'Returns items, total, has_more, and next_offset so the caller can keep paging only when needed.',
      'Use mailboxName to target another mailbox. Do not use when you need full message content for a known emailId (use get_email) or when you need filtered search results (use search_emails or advanced_search).',
    ),
    {
      type: 'object',
      properties: {
        limit: {
          ...numberLikeSchema,
          description: 'Number of recent emails to retrieve (default: 10, max: 50)',
          default: 10,
        },
        mailboxName: {
          type: 'string',
          description: 'Mailbox to search (default: inbox)',
          default: 'inbox',
        },
        offset: {
          ...numberLikeSchema,
          description: 'Zero-based offset for pagination. Use next_offset from the previous response to fetch the next page.',
          default: 0,
        },
      },
    },
  ),
  writeTool(
    'mark_email_read',
    'Mark Email Read',
    description(
      'Mark one email as read or unread.',
      'Use after selecting a specific email when the user wants to clear unread state or mark something unread for later.',
      'Do not use for bulk mailbox triage; use bulk_mark_read.',
    ),
    {
      type: 'object',
      properties: {
        emailId: {
          type: 'string',
          description: 'ID of the email to mark',
        },
        read: {
          ...booleanLikeSchema,
          description: 'true to mark as read, false to mark as unread',
          default: true,
        },
      },
      required: ['emailId'],
    },
    { idempotentHint: true },
  ),
  writeTool(
    'delete_email',
    'Delete Email',
    description(
      'Delete one email by moving it to Trash.',
      'Use when the user explicitly wants a single message deleted or trashed.',
      'Do not use for mailbox cleanup across many messages; use bulk_delete.',
    ),
    {
      type: 'object',
      properties: {
        emailId: {
          type: 'string',
          description: 'ID of the email to delete',
        },
      },
      required: ['emailId'],
    },
    { destructiveHint: true, idempotentHint: true },
  ),
  writeTool(
    'move_email',
    'Move Email',
    description(
      'Move one email to a different Fastmail mailbox.',
      'Use when the user wants a specific message filed into another mailbox.',
      'Do not use to add extra labels while keeping the current mailbox membership; use add_labels.',
    ),
    {
      type: 'object',
      properties: {
        emailId: {
          type: 'string',
          description: 'ID of the email to move',
        },
        targetMailboxId: {
          type: 'string',
          description: 'ID of the target mailbox',
        },
      },
      required: ['emailId', 'targetMailboxId'],
    },
    { idempotentHint: true },
  ),
  writeTool(
    'add_labels',
    'Add Labels',
    description(
      'Add one or more mailbox labels to an email without removing existing ones.',
      'Use when the user wants to tag or categorize a message while keeping its current mailbox membership.',
      'Do not use to relocate an email into a single destination mailbox; use move_email.',
    ),
    {
      type: 'object',
      properties: {
        emailId: {
          type: 'string',
          description: 'ID of the email to add labels to',
        },
        mailboxIds: {
          ...stringArraySchema,
          description: 'Array of mailbox IDs to add as labels',
        },
      },
      required: ['emailId', 'mailboxIds'],
    },
    { idempotentHint: true },
  ),
  writeTool(
    'remove_labels',
    'Remove Labels',
    description(
      'Remove one or more mailbox labels from an email.',
      'Use when the user wants to untag a specific message while leaving any remaining mailbox memberships alone.',
      'Do not use to move an email to Trash; use delete_email.',
    ),
    {
      type: 'object',
      properties: {
        emailId: {
          type: 'string',
          description: 'ID of the email to remove labels from',
        },
        mailboxIds: {
          ...stringArraySchema,
          description: 'Array of mailbox IDs to remove as labels',
        },
      },
      required: ['emailId', 'mailboxIds'],
    },
    { idempotentHint: true },
  ),
  readTool(
    'get_email_attachments',
    'Get Email Attachments',
    description(
      'List the attachments on a specific email.',
      'Use after get_email when you need attachment IDs before downloading one.',
      'Do not use to download content directly; use download_attachment.',
    ),
    {
      type: 'object',
      properties: {
        emailId: {
          type: 'string',
          description: 'ID of the email',
        },
      },
      required: ['emailId'],
    },
  ),
  writeTool(
    'download_attachment',
    'Download Attachment',
    description(
      'Get an attachment download URL or save an attachment to disk when savePath is provided.',
      'Use when the user wants the file from a specific message attachment.',
      'Do not use when you still need to discover attachment IDs; use get_email_attachments first.',
    ),
    {
      type: 'object',
      properties: {
        emailId: {
          type: 'string',
          description: 'ID of the email',
        },
        attachmentId: {
          type: 'string',
          description: 'ID of the attachment',
        },
        savePath: {
          type: 'string',
          description: 'Absolute file path to save the attachment to. Parent directories will be created automatically.',
        },
      },
      required: ['emailId', 'attachmentId'],
    },
  ),
  readTool(
    'advanced_search',
    'Advanced Email Search',
    description(
      'Search Fastmail email with structured filters such as sender, recipient, subject, unread state, attachments, mailbox, and date range in paginated form.',
      'Use when the user asks for something like "find the latest message from Alice", "show unread invoices with attachments", or "find messages from last week".',
      'Returns items, total, has_more, and next_offset so the agent can refine or continue the search without consuming excess context.',
      'Do not use for simple inbox checks; use get_recent_emails. Do not use when you already have an emailId; use get_email.',
    ),
    {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to search for in subject/body',
        },
        from: {
          type: 'string',
          description: 'Filter by sender email',
        },
        to: {
          type: 'string',
          description: 'Filter by recipient email',
        },
        subject: {
          type: 'string',
          description: 'Filter by subject',
        },
        hasAttachment: {
          ...booleanLikeSchema,
          description: 'Filter emails with attachments',
        },
        isUnread: {
          ...booleanLikeSchema,
          description: 'Filter unread emails',
        },
        mailboxId: {
          type: 'string',
          description: 'Search within specific mailbox',
        },
        after: {
          type: 'string',
          description: 'Emails after this date (ISO 8601)',
        },
        before: {
          type: 'string',
          description: 'Emails before this date (ISO 8601)',
        },
        limit: {
          ...numberLikeSchema,
          description: 'Maximum results (default: 20)',
          default: 20,
        },
        offset: {
          ...numberLikeSchema,
          description: 'Zero-based offset for pagination. Use next_offset from the previous response to fetch the next page.',
          default: 0,
        },
      },
    },
  ),
  readTool(
    'get_thread',
    'Get Thread',
    description(
      'Get all emails in one conversation thread.',
      'Use when the user wants the full conversation around a known thread or needs context before replying.',
      'Do not use when you only have one emailId and need the full message first; use get_email.',
    ),
    {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description: 'ID of the thread/conversation',
        },
      },
      required: ['threadId'],
    },
  ),
  readTool(
    'get_mailbox_stats',
    'Get Mailbox Stats',
    description(
      'Get statistics such as unread counts and total emails for a mailbox or across the account.',
      'Use when the user wants a summary of mailbox volume or unread counts rather than individual messages.',
      'Do not use for listing messages themselves.',
    ),
    {
      type: 'object',
      properties: {
        mailboxId: {
          type: 'string',
          description: 'ID of the mailbox (optional, defaults to all mailboxes)',
        },
      },
    },
  ),
  readTool(
    'get_account_summary',
    'Get Account Summary',
    description(
      'Get an overall Fastmail account summary with aggregate mailbox statistics.',
      'Use when the user wants a high-level status view of the mailbox rather than raw email lists.',
      'Do not use for message content or search.',
    ),
    emptySchema,
  ),
  writeTool(
    'bulk_mark_read',
    'Bulk Mark Read',
    description(
      'Mark multiple emails as read or unread in one call.',
      'Use when the user wants to triage a group of specific email IDs together.',
      'Do not use for one email; use mark_email_read.',
    ),
    {
      type: 'object',
      properties: {
        emailIds: {
          ...stringArraySchema,
          description: 'Array of email IDs to mark',
        },
        read: {
          ...booleanLikeSchema,
          description: 'true to mark as read, false as unread',
          default: true,
        },
      },
      required: ['emailIds'],
    },
    { idempotentHint: true },
  ),
  writeTool(
    'bulk_move',
    'Bulk Move',
    description(
      'Move multiple emails to a mailbox in one call.',
      'Use when the user wants to file a set of known email IDs into the same destination mailbox.',
      'Do not use to apply labels while preserving the current mailbox set; use bulk_add_labels.',
    ),
    {
      type: 'object',
      properties: {
        emailIds: {
          ...stringArraySchema,
          description: 'Array of email IDs to move',
        },
        targetMailboxId: {
          type: 'string',
          description: 'ID of target mailbox',
        },
      },
      required: ['emailIds', 'targetMailboxId'],
    },
    { idempotentHint: true },
  ),
  writeTool(
    'bulk_delete',
    'Bulk Delete',
    description(
      'Delete multiple emails by moving them to Trash.',
      'Use when the user explicitly wants to trash a batch of specific messages.',
      'Do not use for a single message; use delete_email.',
    ),
    {
      type: 'object',
      properties: {
        emailIds: {
          ...stringArraySchema,
          description: 'Array of email IDs to delete',
        },
      },
      required: ['emailIds'],
    },
    { destructiveHint: true, idempotentHint: true },
  ),
  writeTool(
    'bulk_add_labels',
    'Bulk Add Labels',
    description(
      'Add labels to multiple emails in one call.',
      'Use when the user wants to categorize many specific messages at once.',
      'Do not use to relocate messages into a different mailbox; use bulk_move.',
    ),
    {
      type: 'object',
      properties: {
        emailIds: {
          ...stringArraySchema,
          description: 'Array of email IDs to add labels to',
        },
        mailboxIds: {
          ...stringArraySchema,
          description: 'Array of mailbox IDs to add as labels',
        },
      },
      required: ['emailIds', 'mailboxIds'],
    },
    { idempotentHint: true },
  ),
  writeTool(
    'bulk_remove_labels',
    'Bulk Remove Labels',
    description(
      'Remove labels from multiple emails in one call.',
      'Use when the user wants to untag a batch of specific messages together.',
      'Do not use to delete or move email.',
    ),
    {
      type: 'object',
      properties: {
        emailIds: {
          ...stringArraySchema,
          description: 'Array of email IDs to remove labels from',
        },
        mailboxIds: {
          ...stringArraySchema,
          description: 'Array of mailbox IDs to remove as labels',
        },
      },
      required: ['emailIds', 'mailboxIds'],
    },
    { idempotentHint: true },
  ),
  readTool(
    'check_function_availability',
    'Check Function Availability',
    description(
      'Report which Fastmail email and identity functions are currently available for this account and API token.',
      'Use when setup seems incomplete, a mail tool fails in an unexpected way, or you need a quick capability summary for the configured account.',
      'Do not use for reading email content or browsing the inbox.',
    ),
    emptySchema,
  ),
  writeTool(
    'test_bulk_operations',
    'Test Bulk Operations',
    description(
      'Test bulk email actions against recent inbox messages, optionally as a dry run.',
      'Use only for safe operational verification of bulk email tooling.',
      'Do not use for normal user-facing mailbox tasks; use the actual bulk tools instead.',
    ),
    {
      type: 'object',
      properties: {
        dryRun: {
          ...booleanLikeSchema,
          description: 'If true, only shows what would be done without making changes (default: true)',
          default: true,
        },
        limit: {
          ...numberLikeSchema,
          description: 'Number of emails to test with (default: 3, max: 10)',
          default: 3,
        },
      },
    },
  ),
];
