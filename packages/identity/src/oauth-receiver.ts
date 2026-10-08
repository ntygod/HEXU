import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../contracts/src/index.js';
import { canonicalJson } from '../../domain/src/index.js';
import type { AgentAssistanceScope } from './agent-assistance-connections.js';
import {
  agentReceiverConnectionById,
  revalidateAgentReceiverConnection,
  type AgentReceiverPrincipal,
} from './agent-receiver-connections.js';

export interface ReceiverAuthorization {
  require(scope: AgentAssistanceScope): void;
}
/** Server-created and persisted with a subscription; never accepted from MCP arguments. */
export interface OAuthSubscriptionAuthority {
  issuer: string;
  bindingId: string;
  scopes: string[];
  tokenExpiresAt: number;
}
export interface OAuthReceiverAccess extends ReceiverAuthorization {
  actor: AgentReceiverPrincipal;
  subscription: OAuthSubscriptionAuthority;
}
export interface OAuthReceiverResource {
  database: DatabaseSync;
  resource: string;
  issuer: string;
  metadataURL: string;
  authenticate(headers: Record<string, unknown>): Promise<OAuthReceiverAccess>;
  revalidateSubscription(authority: OAuthSubscriptionAuthority): AgentReceiverPrincipal;
}
export const oauthDenied = () =>
  new DomainError('OAUTH_AUTH_REQUIRED', 'OAuth authorization is no longer valid', 401);
export const oauthScopeDenied = () =>
  new DomainError('OAUTH_SCOPE_REQUIRED', 'OAuth authorization lacks the required scope', 403);
export const oauthCodeHash = (code: string) => createHash('sha256').update(code).digest('hex');

interface Binding {
  id: string;
  issuer: string;
  subject: string;
  client_id: string;
  resource: string;
  receiver: string;
  scopes: string;
  expires_at: string;
  revoked_at: string | null;
}
/** Same identity SQLite transaction as provider consent/code; never issues a receiver credential. */
export class OAuthReceiverBindings {
  constructor(
    private readonly db: DatabaseSync,
    readonly database: DatabaseSync,
    readonly issuer: string,
    readonly clientId: string,
    readonly resource: string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS hexu_oauth_receiver_bindings (
      id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL REFERENCES user(id),
      client_id TEXT NOT NULL, resource TEXT NOT NULL, receiver TEXT NOT NULL, scopes TEXT NOT NULL,
      expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hexu_oauth_receiver_codes (
      code_hash TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES hexu_oauth_receiver_bindings(id)
    );`);
  }
  private row(id: string): Binding {
    const row = this.db
      .prepare('SELECT * FROM hexu_oauth_receiver_bindings WHERE id=?')
      .get(id) as unknown as Binding | undefined;
    if (
      !row ||
      row.issuer !== this.issuer ||
      row.client_id !== this.clientId ||
      row.resource !== this.resource ||
      row.revoked_at ||
      row.expires_at <= new Date().toISOString()
    )
      throw oauthDenied();
    return row;
  }
  current(id: string) {
    const row = this.row(id);
    const client = this.db
      .prepare('SELECT disabled FROM oauthClient WHERE clientId=?')
      .get(this.clientId);
    if (!client || client.disabled) throw oauthDenied();
    const actor = JSON.parse(row.receiver) as AgentReceiverPrincipal;
    if (actor.ownerUserId !== row.subject || actor.expiresAt !== row.expires_at)
      throw oauthDenied();
    // Deliberately preserve the original complete principal and its scopes for equality validation.
    try {
      revalidateAgentReceiverConnection(this.database, actor);
    } catch {
      throw oauthDenied();
    }
    return { row, actor };
  }
  choices(subject: string) {
    const rows = this.database
      .prepare(
        `SELECT c.id FROM agent_receiver_connections c
      JOIN agent_participants a ON a.id=c.participant_id WHERE a.owner_user_id=?
      AND c.revoked_at IS NULL ORDER BY c.created_at DESC LIMIT 100`,
      )
      .all(subject) as { id: string }[];
    return rows.flatMap(({ id }) => {
      try {
        const a = agentReceiverConnectionById(this.database, id);
        return [
          {
            connectionId: a.connectionId,
            connectionRevision: a.connectionRevision,
            participantId: a.participantId,
            projectId: a.projectId,
            target: a.target,
            scopes: a.scopes,
            expiresAt: a.expiresAt,
          },
        ];
      } catch {
        return [];
      }
    });
  }
  create(subject: string, selection: unknown, scopes: string[]) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection))
      throw oauthDenied();
    const s = selection as Record<string, unknown>;
    if (
      Object.keys(s).some((k) => !['connectionId', 'connectionRevision'].includes(k)) ||
      typeof s.connectionId !== 'string' ||
      !Number.isSafeInteger(s.connectionRevision)
    )
      throw oauthDenied();
    const actor = agentReceiverConnectionById(this.database, s.connectionId);
    if (actor.ownerUserId !== subject || actor.connectionRevision !== s.connectionRevision)
      throw oauthDenied();
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO hexu_oauth_receiver_bindings VALUES(?,?,?,?,?,?,?,?,NULL,?)')
      .run(
        id,
        this.issuer,
        subject,
        this.clientId,
        this.resource,
        canonicalJson(actor),
        JSON.stringify(scopes),
        actor.expiresAt,
        new Date().toISOString(),
      );
    return id;
  }
  attachCode(id: string, code: string) {
    this.current(id);
    this.db
      .prepare('INSERT INTO hexu_oauth_receiver_codes VALUES(?,?)')
      .run(oauthCodeHash(code), id);
  }
  fromCode(code: string) {
    const row = this.db
      .prepare('SELECT binding_id FROM hexu_oauth_receiver_codes WHERE code_hash=?')
      .get(oauthCodeHash(code)) as { binding_id: string } | undefined;
    if (!row) throw oauthDenied();
    this.current(row.binding_id);
    return row.binding_id;
  }
  claims(
    id: string,
    subject: string | undefined,
    scopes: string[],
    resources: string[] | undefined,
  ) {
    const { row } = this.current(id);
    if (
      subject !== row.subject ||
      resources?.length !== 1 ||
      resources[0] !== row.resource ||
      canonicalJson([...scopes].sort()) !==
        canonicalJson((JSON.parse(row.scopes) as string[]).sort())
    )
      throw oauthDenied();
    return { hexu_binding: id };
  }
  access(claims: Record<string, unknown>): OAuthReceiverAccess {
    if (
      typeof claims.hexu_binding !== 'string' ||
      typeof claims.sub !== 'string' ||
      claims.client_id !== this.clientId ||
      claims.iss !== this.issuer ||
      claims.aud !== this.resource ||
      typeof claims.exp !== 'number' ||
      typeof claims.iat !== 'number' ||
      typeof claims.scope !== 'string' ||
      claims.cnf !== undefined ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.iat > Math.floor(Date.now() / 1000) ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 300
    )
      throw oauthDenied();
    const authority: OAuthSubscriptionAuthority = {
      issuer: this.issuer,
      bindingId: claims.hexu_binding,
      scopes: claims.scope.split(' '),
      tokenExpiresAt: claims.exp * 1000,
    };
    const { row, actor } = this.current(authority.bindingId);
    if (row.subject !== claims.sub) throw oauthDenied();
    const require = (scope: AgentAssistanceScope) => this.require(authority, scope, actor);
    require('material_read');
    return { actor, require, subscription: authority };
  }
  require(
    authority: OAuthSubscriptionAuthority,
    scope: AgentAssistanceScope,
    original?: AgentReceiverPrincipal,
  ) {
    if (
      authority.issuer !== this.issuer ||
      !Number.isFinite(authority.tokenExpiresAt) ||
      authority.tokenExpiresAt <= Date.now() ||
      !Array.isArray(authority.scopes)
    )
      throw oauthDenied();
    const { row, actor } = this.current(authority.bindingId);
    if (original && canonicalJson(original) !== canonicalJson(actor)) throw oauthDenied();
    const approved = JSON.parse(row.scopes) as string[];
    if (
      !authority.scopes.includes('hexu:' + scope) ||
      !approved.includes('hexu:' + scope) ||
      !actor.scopes.includes(scope)
    )
      throw oauthScopeDenied();
    return actor;
  }
  list(subject: string) {
    return (
      this.db
        .prepare(
          'SELECT * FROM hexu_oauth_receiver_bindings WHERE subject=? AND issuer=? AND client_id=? AND resource=? ORDER BY created_at DESC LIMIT 100',
        )
        .all(subject, this.issuer, this.clientId, this.resource) as unknown as Binding[]
    ).map((row) => {
      const actor = JSON.parse(row.receiver) as AgentReceiverPrincipal;
      return {
        id: row.id,
        connectionId: actor.connectionId,
        connectionRevision: actor.connectionRevision,
        scopes: JSON.parse(row.scopes) as string[],
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      };
    });
  }
  revoke(subject: string, id: string) {
    // Ownership is checked even for an already revoked/expired binding. Idempotent, no revival.
    const row = this.db
      .prepare(
        'SELECT subject FROM hexu_oauth_receiver_bindings WHERE id=? AND issuer=? AND client_id=? AND resource=?',
      )
      .get(id, this.issuer, this.clientId, this.resource);
    if (!row || row.subject !== subject) throw oauthDenied();
    this.db
      .prepare(
        'UPDATE hexu_oauth_receiver_bindings SET revoked_at=COALESCE(revoked_at,?) WHERE id=?',
      )
      .run(new Date().toISOString(), id);
  }
}
