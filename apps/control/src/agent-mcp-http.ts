import type { FastifyInstance } from 'fastify';
import { DomainError, record } from '../../../packages/contracts/src/index.js';
import { authenticateAgentReceiverConnection } from '../../../packages/identity/src/agent-receiver-connections.js';
import { matches, toolsFor } from '../../mcp/src/tools.js';
import { AgentEvents, EVENT_DEFINITION } from './agent-events.js';
import { CallbackError } from './event-webhook.js';
import {
  oauthDenied,
  type OAuthReceiverAccess,
} from '../../../packages/identity/src/oauth-receiver.js';
export const MCP_VERSION = '2026-07-28';
export const MCP_PATH = '/collaboration/mcp';
/** Separate stateless MCP2 surface. Classic 2025-11-25 stdio remains unchanged. */
export function attachAgentMcpHttp(app: FastifyInstance, events: AgentEvents) {
  const oauth = events.oauth;
  const boundary = (headers: Record<string, unknown>, url: string, expectedPath: string) => {
    if (
      headers.host !== new URL(oauth!.resource).host ||
      url !== expectedPath ||
      headers.forwarded ||
      Object.keys(headers).some((k) => k.startsWith('x-forwarded-')) ||
      headers.origin ||
      headers.cookie ||
      headers['sec-fetch-site']
    )
      throw oauthDenied();
  };
  if (oauth)
    app.get(new URL(oauth.metadataURL).pathname, async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        boundary(req.headers, req.url, new URL(oauth.metadataURL).pathname);
      } catch {
        return reply.code(403).send({ error: 'access_denied' });
      }
      return {
        resource: oauth.resource,
        authorization_servers: [oauth.issuer],
        scopes_supported: ['hexu:material_read', 'hexu:respond'],
      };
    });
  const tools = toolsFor('receiver')
    .map((t) =>
      t.name === 'hexu_list_requests'
        ? {
            ...t,
            description:
              'List finite requests within this explicitly approved receiver grant. Reads current authorization; no parent Task/project access and no model launch.',
          }
        : t,
    )
    .map((t) => ({
      ...t,
      ...(oauth
        ? {
            securitySchemes: [
              {
                type: 'oauth2',
                scopes:
                  t.name === 'hexu_respond'
                    ? ['hexu:material_read', 'hexu:respond']
                    : ['hexu:material_read'],
              },
            ],
          }
        : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  app.post(MCP_PATH, { bodyLimit: 65536 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    let id: unknown = null;
    let method: unknown = null,
      toolName: unknown = null;
    const fail = (status: number, code: number, message: string, data?: unknown) =>
      reply
        .code(status)
        .send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
    try {
      if (oauth) boundary(req.headers, req.url, MCP_PATH);
      const legacy = oauth
        ? undefined
        : authenticateAgentReceiverConnection(events.store.db, req.headers);
      const body = record(req.body);
      id = body.id ?? null;
      if (
        body.jsonrpc !== '2.0' ||
        (typeof id !== 'string' && typeof id !== 'number') ||
        (typeof id === 'number' && !Number.isSafeInteger(id)) ||
        typeof body.method !== 'string' ||
        Object.keys(body).some((k) => !['jsonrpc', 'id', 'method', 'params'].includes(k))
      )
        return fail(400, -32600, 'Invalid Request');
      const p = record(body.params),
        meta = record(p._meta);
      if (
        typeof meta['io.modelcontextprotocol/protocolVersion'] !== 'string' ||
        !meta['io.modelcontextprotocol/clientCapabilities'] ||
        typeof meta['io.modelcontextprotocol/clientCapabilities'] !== 'object' ||
        Array.isArray(meta['io.modelcontextprotocol/clientCapabilities'])
      )
        return fail(400, -32602, 'Required MCP metadata missing');
      const version = meta['io.modelcontextprotocol/protocolVersion'];
      if (version !== MCP_VERSION)
        return fail(400, -32022, 'Unsupported protocol version', {
          supported: [MCP_VERSION],
          requested: version,
        });
      let headerName = req.headers['mcp-name'];
      if (typeof headerName === 'string' && /^=\?base64\?.*\?=$/.test(headerName)) {
        try {
          headerName = Buffer.from(headerName.slice(9, -2), 'base64').toString('utf8');
        } catch {
          return fail(400, -32020, 'MCP headers mismatch');
        }
      }
      if (
        req.headers['mcp-protocol-version'] !== version ||
        req.headers['mcp-method'] !== body.method ||
        (body.method === 'tools/call' && headerName !== p.name)
      )
        return fail(400, -32020, 'MCP headers mismatch');
      method = body.method;
      toolName = p.name;
      const { _meta: ignored, ...params } = p;
      // Only protocol/tool metadata is public. No inbox, event subscription or tool result is anonymous.
      const publicDiscovery =
        oauth &&
        !req.headers.authorization &&
        ['server/discover', 'tools/list'].includes(body.method);
      const access: OAuthReceiverAccess | undefined =
        oauth && !publicDiscovery ? await oauth.authenticate(req.headers) : undefined;
      const actor = access?.actor ?? legacy!;
      access?.require('material_read');
      let result: unknown;
      switch (body.method) {
        case 'server/discover':
          if (Object.keys(params).length) return fail(400, -32602, 'Unexpected parameters');
          result = {
            resultType: 'complete',
            supportedVersions: [MCP_VERSION],
            capabilities: { tools: {}, events: {} },
            _meta: {
              'io.modelcontextprotocol/serverInfo': {
                name: 'HEXU finite collaboration',
                version: '0.1.0',
              },
            },
          };
          break;
        case 'events/list':
          if (
            Object.keys(params).some((k) => k !== 'cursor') ||
            (params.cursor !== undefined && params.cursor !== null)
          )
            return fail(400, -32602, 'Unsupported cursor');
          result = { events: [EVENT_DEFINITION] };
          break;
        case 'events/subscribe':
          result = await events.subscribe(actor, params, access);
          break;
        case 'events/unsubscribe':
          result = events.unsubscribe(actor, params, access);
          break;
        case 'tools/list':
          if (
            Object.keys(params).some((k) => k !== 'cursor') ||
            (params.cursor !== undefined && params.cursor !== null)
          )
            return fail(400, -32602, 'Unsupported cursor');
          result = { resultType: 'complete', tools };
          break;
        case 'tools/call': {
          if (Object.keys(params).some((k) => !['name', 'arguments'].includes(k)))
            return fail(400, -32602, 'Unexpected parameters');
          const tool = tools.find((t) => t.name === params.name);
          if (!tool || !matches(tool.inputSchema, params.arguments))
            return fail(400, -32602, 'Invalid tool or arguments');
          const a = record(params.arguments);
          let data: unknown;
          switch (tool.name) {
            case 'hexu_list_requests':
              data = { items: events.receiver.list(actor, access) };
              break;
            case 'hexu_get_request':
              data = events.receiver.get(actor, a.requestId as string, access);
              break;
            case 'hexu_read_materials':
              data = events.receiver.input(
                actor,
                a.requestId as string,
                a.inputRevision as number,
                access,
              );
              break;
            case 'hexu_respond':
              data = events.receiver.respond(
                actor,
                a.requestId as string,
                a.response,
                a.operationKey as string,
                access,
              );
              break;
          }
          result = {
            resultType: 'complete',
            content: [{ type: 'text', text: JSON.stringify(data) }],
            structuredContent: data,
          };
          break;
        }
        default:
          return fail(404, -32601, 'Method not found');
      }
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (oauth && error instanceof DomainError && [401, 403].includes(error.status)) {
        const scope =
          toolName === 'hexu_respond' ? 'hexu:material_read hexu:respond' : 'hexu:material_read';
        const challenge = `Bearer resource_metadata="${oauth.metadataURL}", scope="${scope}", error="${error.status === 403 ? 'insufficient_scope' : 'invalid_token'}", error_description="Current finite authorization required"`;
        reply.header('WWW-Authenticate', challenge);
        if (method === 'tools/call')
          return reply.code(error.status).send({
            jsonrpc: '2.0',
            id,
            result: {
              resultType: 'complete',
              isError: true,
              content: [{ type: 'text', text: 'Current finite authorization required' }],
              _meta: { 'mcp/www_authenticate': [challenge] },
            },
          });
      }
      if (error instanceof CallbackError)
        return fail(400, -32015, 'Callback verification failed', { reason: error.reason });
      if (error instanceof DomainError)
        return fail(
          error.status,
          error.status === 401 ? -32001 : -32602,
          'Request not authorized or invalid',
          { code: error.code },
        );
      return fail(500, -32603, 'Internal error');
    }
  });
}
