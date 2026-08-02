import { IntegrationCategory } from '@prisma/client';
import { HttpConnectorSpec, httpConnectorFactory } from './http-connector';
import { ConnectorFactory } from './connector.contract';

/**
 * The built-in connector catalogue.
 *
 * Each entry is a declaration, not an implementation — base URL, how the
 * credential is attached, and one line per action. That is the whole cost of
 * adding a service; retries, circuit breaking, permission checks, credential
 * decryption, usage accounting and health probing come from the shared layer.
 *
 * These are written against each vendor's documented REST API. Without
 * credentials they are unexercised against live endpoints in this
 * environment — see the SIMULATED connector below, which is what the
 * validation suite drives so the surrounding machinery is genuinely proven.
 */

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

const slack: HttpConnectorSpec = {
  kind: 'slack',
  displayName: 'Slack',
  category: IntegrationCategory.MESSAGING,
  authMethod: 'bearer',
  baseUrl: 'https://slack.com/api',
  auth: bearer,
  probe: { method: 'POST', path: '/auth.test' },
  actions: [
    {
      key: 'send_message',
      description: 'Post a message to a channel.',
      requires: 'send',
      mutates: true,
      method: 'POST',
      path: '/chat.postMessage',
      body: { channel: '{{channel}}', text: '{{text}}' },
      externalIdPath: 'ts',
      parameters: {
        channel: { type: 'string', description: 'Channel id or name.', required: true },
        text: { type: 'string', description: 'Message body.', required: true },
      },
    },
    {
      key: 'list_channels',
      description: 'List conversations the token can see.',
      requires: 'read',
      mutates: false,
      method: 'GET',
      path: '/conversations.list',
      parameters: {},
    },
  ],
};

const telegram: HttpConnectorSpec = {
  kind: 'telegram',
  displayName: 'Telegram',
  category: IntegrationCategory.MESSAGING,
  authMethod: 'api_key',
  // The bot token sits in the path rather than a header, which is why the
  // base URL is templated per-integration via `options.baseUrl`.
  baseUrl: 'https://api.telegram.org',
  auth: () => ({}),
  actions: [
    {
      key: 'send_message',
      description: 'Send a message to a chat.',
      requires: 'send',
      mutates: true,
      method: 'POST',
      path: '/sendMessage',
      body: { chat_id: '{{chatId}}', text: '{{text}}' },
      externalIdPath: 'result.message_id',
      parameters: {
        chatId: { type: 'string', description: 'Target chat id.', required: true },
        text: { type: 'string', description: 'Message body.', required: true },
      },
    },
  ],
};

const discord: HttpConnectorSpec = {
  kind: 'discord',
  displayName: 'Discord',
  category: IntegrationCategory.MESSAGING,
  authMethod: 'api_key',
  baseUrl: 'https://discord.com/api/v10',
  auth: (secret) => ({ authorization: `Bot ${secret}` }),
  actions: [
    {
      key: 'send_message',
      description: 'Post a message to a channel.',
      requires: 'send',
      mutates: true,
      method: 'POST',
      path: '/channels/{{channelId}}/messages',
      body: { content: '{{content}}' },
      externalIdPath: 'id',
      parameters: {
        channelId: { type: 'string', description: 'Channel id.', required: true },
        content: { type: 'string', description: 'Message body.', required: true },
      },
    },
  ],
};

const github: HttpConnectorSpec = {
  kind: 'github',
  displayName: 'GitHub',
  category: IntegrationCategory.CUSTOM_API,
  authMethod: 'bearer',
  baseUrl: 'https://api.github.com',
  auth: (secret) => ({ authorization: `Bearer ${secret}`, accept: 'application/vnd.github+json' }),
  probe: { method: 'GET', path: '/user' },
  actions: [
    {
      key: 'create_issue',
      description: 'Open an issue on a repository.',
      requires: 'write',
      mutates: true,
      method: 'POST',
      path: '/repos/{{owner}}/{{repo}}/issues',
      body: { title: '{{title}}', body: '{{body}}' },
      externalIdPath: 'number',
      parameters: {
        owner: { type: 'string', description: 'Repository owner.', required: true },
        repo: { type: 'string', description: 'Repository name.', required: true },
        title: { type: 'string', description: 'Issue title.', required: true },
        body: { type: 'string', description: 'Issue body.' },
      },
    },
    {
      key: 'list_issues',
      description: 'List open issues.',
      requires: 'read',
      mutates: false,
      method: 'GET',
      path: '/repos/{{owner}}/{{repo}}/issues',
      parameters: {
        owner: { type: 'string', description: 'Repository owner.', required: true },
        repo: { type: 'string', description: 'Repository name.', required: true },
      },
    },
  ],
};

const notion: HttpConnectorSpec = {
  kind: 'notion',
  displayName: 'Notion',
  category: IntegrationCategory.DATABASE,
  authMethod: 'bearer',
  baseUrl: 'https://api.notion.com/v1',
  auth: (secret) => ({ authorization: `Bearer ${secret}`, 'notion-version': '2022-06-28' }),
  probe: { method: 'GET', path: '/users/me' },
  actions: [
    {
      key: 'create_page',
      description: 'Create a page in a database.',
      requires: 'write',
      mutates: true,
      method: 'POST',
      path: '/pages',
      body: {
        parent: { database_id: '{{databaseId}}' },
        properties: '{{properties}}',
      },
      externalIdPath: 'id',
      parameters: {
        databaseId: { type: 'string', description: 'Target database.', required: true },
        properties: { type: 'object', description: 'Notion property map.', required: true },
      },
    },
    {
      key: 'query_database',
      description: 'Query a database.',
      requires: 'read',
      mutates: false,
      method: 'POST',
      path: '/databases/{{databaseId}}/query',
      body: {},
      parameters: {
        databaseId: { type: 'string', description: 'Database to query.', required: true },
      },
    },
  ],
};

const stripe: HttpConnectorSpec = {
  kind: 'stripe',
  displayName: 'Stripe',
  category: IntegrationCategory.PAYMENT,
  authMethod: 'bearer',
  baseUrl: 'https://api.stripe.com/v1',
  auth: bearer,
  probe: { method: 'GET', path: '/balance' },
  actions: [
    {
      key: 'list_customers',
      description: 'List customers.',
      requires: 'read',
      mutates: false,
      method: 'GET',
      path: '/customers',
      parameters: {},
    },
    {
      key: 'get_charge',
      description: 'Retrieve one charge.',
      requires: 'read',
      mutates: false,
      method: 'GET',
      path: '/charges/{{chargeId}}',
      parameters: {
        chargeId: { type: 'string', description: 'Charge id.', required: true },
      },
    },
  ],
};

const gmail: HttpConnectorSpec = {
  kind: 'gmail',
  displayName: 'Gmail',
  category: IntegrationCategory.EMAIL,
  authMethod: 'oauth2',
  baseUrl: 'https://gmail.googleapis.com/gmail/v1',
  auth: bearer,
  probe: { method: 'GET', path: '/users/me/profile' },
  actions: [
    {
      key: 'send_email',
      description: 'Send a message. `raw` must be base64url-encoded RFC 2822.',
      requires: 'send',
      mutates: true,
      method: 'POST',
      path: '/users/me/messages/send',
      body: { raw: '{{raw}}' },
      externalIdPath: 'id',
      parameters: {
        raw: { type: 'string', description: 'base64url RFC 2822 message.', required: true },
      },
    },
    {
      key: 'list_messages',
      description: 'List messages in the mailbox.',
      requires: 'read',
      mutates: false,
      method: 'GET',
      path: '/users/me/messages',
      parameters: {},
    },
  ],
};

const airtable: HttpConnectorSpec = {
  kind: 'airtable',
  displayName: 'Airtable',
  category: IntegrationCategory.DATABASE,
  authMethod: 'bearer',
  baseUrl: 'https://api.airtable.com/v0',
  auth: bearer,
  actions: [
    {
      key: 'create_record',
      description: 'Create a record in a table.',
      requires: 'write',
      mutates: true,
      method: 'POST',
      path: '/{{baseId}}/{{table}}',
      body: { fields: '{{fields}}' },
      externalIdPath: 'id',
      parameters: {
        baseId: { type: 'string', description: 'Airtable base id.', required: true },
        table: { type: 'string', description: 'Table name.', required: true },
        fields: { type: 'object', description: 'Field map.', required: true },
      },
    },
    {
      key: 'list_records',
      description: 'List records in a table.',
      requires: 'read',
      mutates: false,
      method: 'GET',
      path: '/{{baseId}}/{{table}}',
      parameters: {
        baseId: { type: 'string', description: 'Airtable base id.', required: true },
        table: { type: 'string', description: 'Table name.', required: true },
      },
    },
  ],
};

const hubspot: HttpConnectorSpec = {
  kind: 'hubspot',
  displayName: 'HubSpot',
  category: IntegrationCategory.CRM,
  authMethod: 'bearer',
  baseUrl: 'https://api.hubapi.com',
  auth: bearer,
  actions: [
    {
      key: 'create_contact',
      description: 'Create a CRM contact.',
      requires: 'write',
      mutates: true,
      method: 'POST',
      path: '/crm/v3/objects/contacts',
      body: { properties: '{{properties}}' },
      externalIdPath: 'id',
      parameters: {
        properties: { type: 'object', description: 'Contact properties.', required: true },
      },
    },
    {
      key: 'list_contacts',
      description: 'List CRM contacts.',
      requires: 'read',
      mutates: false,
      method: 'GET',
      path: '/crm/v3/objects/contacts',
      parameters: {},
    },
  ],
};

/**
 * A generic outbound HTTP connector.
 *
 * The escape hatch: any service without a purpose-built connector can still be
 * reached by configuring `options.baseUrl` and calling `request`.
 */
const restApi: HttpConnectorSpec = {
  kind: 'rest',
  displayName: 'REST API',
  category: IntegrationCategory.CUSTOM_API,
  authMethod: 'bearer',
  baseUrl: '',
  auth: (secret, options) => {
    if (!secret) return {};
    const scheme = (options.authScheme as string) ?? 'bearer';
    if (scheme === 'header') {
      return { [(options.authHeader as string) ?? 'x-api-key']: secret };
    }
    if (scheme === 'basic') return { authorization: `Basic ${secret}` };
    return { authorization: `Bearer ${secret}` };
  },
  actions: [
    {
      key: 'request',
      description: 'Call an arbitrary path on the configured base URL.',
      requires: 'write',
      mutates: true,
      method: 'POST',
      path: '{{path}}',
      body: { '{{__passthrough}}': '{{body}}' },
      parameters: {
        path: { type: 'string', description: 'Path or absolute URL.', required: true },
        body: { type: 'object', description: 'Request body.' },
      },
    },
    {
      key: 'get',
      description: 'GET a path on the configured base URL.',
      requires: 'read',
      mutates: false,
      method: 'GET',
      path: '{{path}}',
      parameters: {
        path: { type: 'string', description: 'Path or absolute URL.', required: true },
      },
    },
  ],
};

export const BUILT_IN_CONNECTORS: ConnectorFactory[] = [
  slack,
  telegram,
  discord,
  github,
  notion,
  stripe,
  gmail,
  airtable,
  hubspot,
  restApi,
].map(httpConnectorFactory);
