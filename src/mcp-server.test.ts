import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, McpClientContext } from './mcp-server.js';

function createTestContext(capabilities: Record<string, unknown> = {}): McpClientContext {
  const mailClient = {
    async getSession() {
      return {
        apiUrl: 'https://api.fastmail.com/jmap/api/',
        accountId: 'acct-123',
        capabilities,
      };
    },
  } as any;

  return {
    getMailClient() {
      return mailClient;
    },
  };
}

async function connectTestClient(context: McpClientContext) {
  const server = createMcpServer(context);
  const client = new Client(
    { name: 'fastmail-mcp-test-client', version: '1.0.0' },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { server, client };
}

describe('createMcpServer tool metadata', () => {
  it('lists 28 tools with paginated email metadata and no contacts', async () => {
    const { client, server } = await connectTestClient(createTestContext());

    try {
      const result = await client.listTools();
      const toolNames = new Set(result.tools.map((tool) => tool.name));

      assert.equal(result.tools.length, 28);
      assert.equal(toolNames.has('list_calendars'), false);
      assert.equal(toolNames.has('list_calendar_events'), false);
      assert.equal(toolNames.has('get_calendar_event'), false);
      assert.equal(toolNames.has('create_calendar_event'), false);
      assert.equal(toolNames.has('list_contacts'), false);
      assert.equal(toolNames.has('get_contact'), false);
      assert.equal(toolNames.has('search_contacts'), false);

      const recentEmails = result.tools.find((tool) => tool.name === 'get_recent_emails');
      assert.ok(recentEmails);
      assert.match(recentEmails.description ?? '', /check email/i);
      assert.match(recentEmails.description ?? '', /read my inbox/i);
      assert.match(recentEmails.description ?? '', /next_offset/i);
      assert.ok('offset' in (recentEmails.inputSchema.properties ?? {}));
      assert.equal(recentEmails.annotations?.readOnlyHint, true);
      assert.equal(recentEmails.annotations?.destructiveHint, false);
      assert.equal(recentEmails.annotations?.idempotentHint, true);
      assert.equal(recentEmails.annotations?.openWorldHint, true);

      const sendEmail = result.tools.find((tool) => tool.name === 'send_email');
      assert.ok(sendEmail);
      assert.match(sendEmail.description ?? '', /threaded replies/i);
      assert.equal(sendEmail.annotations?.readOnlyHint, false);
      assert.equal(sendEmail.annotations?.destructiveHint, false);
      assert.equal(sendEmail.annotations?.idempotentHint, false);
      assert.equal(sendEmail.annotations?.openWorldHint, true);

      const deleteEmail = result.tools.find((tool) => tool.name === 'delete_email');
      assert.ok(deleteEmail);
      assert.equal(deleteEmail.annotations?.destructiveHint, true);

      const advancedSearch = result.tools.find((tool) => tool.name === 'advanced_search');
      assert.ok(advancedSearch);
      assert.ok('offset' in (advancedSearch.inputSchema.properties ?? {}));
      assert.match(advancedSearch.description ?? '', /has_more/i);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});

describe('check_function_availability', () => {
  it('reports email and identity only without contacts metadata', async () => {
    const { client, server } = await connectTestClient(
      createTestContext({ 'urn:ietf:params:jmap:contacts': {} }),
    );

    try {
      const result = await client.callTool({
        name: 'check_function_availability',
        arguments: {},
      });

      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, 'text');

      const availability = JSON.parse(result.content[0].text);

      assert.equal(availability.email.available, true);
      assert.deepEqual(availability.identity.functions, ['list_identities']);
      assert.equal('contacts' in availability, false);
      assert.equal('calendar' in availability, false);
      assert.deepEqual(availability.capabilities, ['urn:ietf:params:jmap:contacts']);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
