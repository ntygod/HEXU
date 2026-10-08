import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DomainError, record } from '../../../packages/contracts/src/index.js';
import { canonicalJson } from '../../../packages/domain/src/index.js';
import type { Store } from '../../../packages/db/src/store.js';
import { AgentReceiverStore } from '../../../packages/db/src/agent-receiver.js';
import {
  agentReceiverConnectionById,
  revalidateAgentReceiverConnection,
  type AgentReceiverPrincipal,
} from '../../../packages/identity/src/agent-receiver-connections.js';
import type {
  OAuthReceiverAccess,
  OAuthReceiverResource,
  OAuthSubscriptionAuthority,
} from '../../../packages/identity/src/oauth-receiver.js';
import {
  callbackURL,
  signingKey,
  signedHeaders,
  verifyCallback,
  postWebhook,
  type WebhookSender,
} from './event-webhook.js';
export const EVENT_NAME = 'hexu.assistance.changed';
export const EVENT_DEFINITION = {
  name: EVENT_NAME,
  description:
    'An authorized finite assistance changed. Read its current state through HEXU tools. This is a delivery hint, not acceptance or completion of Agent work.',
  delivery: ['webhook'],
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  payloadSchema: {
    type: 'object',
    properties: { requestId: { type: 'string' } },
    required: ['requestId'],
    additionalProperties: false,
  },
};
type Subscription = {
  id: string;
  connection_id: string;
  connection_revision: number;
  participant_id: string;
  grant_id: string;
  identity_hash: string;
  generation: number;
  expires_at: string;
  revoked_at: string | null;
  private_body: string;
  verified_until: string;
  oauth_authority: string | null;
};
type Private = { url: string; secret: string; previousSecret?: string; rotateUntil?: string };
type Delivery = {
  id: string;
  subscription_id: string;
  sequence: number;
  request_id: string;
  occurred_at: string;
  state: string;
  attempts: number;
  next_at: string;
};
const at = () => new Date().toISOString();
const invalid = () => new DomainError('INVALID_INPUT', '事件参数无效', 422);
/** Single-process durable delivery coordinator. No task/run creation, no replay of model work. */
export class AgentEvents {
  private busy = false;
  readonly receiver: AgentReceiverStore;
  constructor(
    readonly store: Store,
    private readonly encryptionKey: Buffer,
    private readonly sender: WebhookSender = postWebhook,
    readonly oauth?: OAuthReceiverResource,
  ) {
    if (encryptionKey.length !== 32 || !store.teamMode)
      throw new Error('Events require team data and a 32-byte encryption key');
    if (oauth && oauth.database !== store.db)
      throw new Error('OAuth receiver database must match Events');
    this.receiver = new AgentReceiverStore(store);
    // Process death during delivery is unknown receipt, never inferred Agent completion.
    store.db
      .prepare("UPDATE agent_event_deliveries SET state='unknown' WHERE state='inflight'")
      .run();
  }
  private encrypt(value: Private, id: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(id));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), bytes].map((b) => b.toString('base64')).join('.');
  }
  private decrypt(s: Subscription): Private {
    try {
      const [iv, tag, body] = s.private_body.split('.').map((v) => Buffer.from(v, 'base64'));
      const cipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv!);
      cipher.setAAD(Buffer.from(s.id));
      cipher.setAuthTag(tag!);
      return JSON.parse(
        Buffer.concat([cipher.update(body!), cipher.final()]).toString('utf8'),
      ) as Private;
    } catch {
      throw new DomainError('EVENT_STORAGE_UNAVAILABLE', '事件安全存储不可用', 503);
    }
  }
  private row(id: string) {
    return this.store.db.prepare('SELECT * FROM agent_event_subscriptions WHERE id=?').get(id) as
      | Subscription
      | undefined;
  }
  private identity(
    actor: AgentReceiverPrincipal,
    input: unknown,
    subscribe: boolean,
    access?: OAuthReceiverAccess,
  ) {
    access?.require('material_read');
    revalidateAgentReceiverConnection(this.store.db, actor);
    const p = record(input),
      delivery = record(p.delivery);
    if (
      p.name !== EVENT_NAME ||
      Object.keys(record(p.arguments)).length ||
      delivery.mode !== 'webhook' ||
      Object.keys(p).some(
        (k) => !['name', 'arguments', 'delivery', 'cursor', 'ttlMs'].includes(k),
      ) ||
      Object.keys(delivery).some(
        (k) => !(subscribe ? ['mode', 'url', 'secret'] : ['mode', 'url']).includes(k),
      ) ||
      (p.cursor !== undefined && p.cursor !== null)
    )
      throw invalid();
    const url = callbackURL(delivery.url).href;
    const identity = canonicalJson({
      connectionId: actor.connectionId,
      ...(access
        ? { oauthBinding: access.subscription.bindingId, issuer: access.subscription.issuer }
        : {}),
      url,
      name: EVENT_NAME,
      arguments: {},
    });
    const id = `sub_${createHash('sha256').update(identity).digest('hex')}`;
    return { p, delivery, url, id };
  }
  async subscribe(actor: AgentReceiverPrincipal, input: unknown, access?: OAuthReceiverAccess) {
    const { p, delivery, url, id } = this.identity(actor, input, true, access);
    signingKey(delivery.secret);
    const secret = delivery.secret as string;
    const ttl = p.ttlMs === undefined || p.ttlMs === null ? 3600000 : p.ttlMs;
    if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl <= 0) throw invalid();
    const expiry = new Date(
      Math.min(
        Date.now() + Math.min(ttl, 86400000),
        Date.parse(actor.expiresAt),
        access?.subscription.tokenExpiresAt ?? Infinity,
      ),
    ).toISOString();
    let previous: Private | undefined,
      cached = false;
    const generation = this.store.atomic(() => {
      access?.require('material_read');
      revalidateAgentReceiverConnection(this.store.db, actor);
      const old = this.row(id);
      if (old) {
        previous = this.decrypt(old);
        cached = !old.revoked_at && old.verified_until > at() && previous.secret === secret;
      }
      this.store.db
        .prepare(
          'INSERT INTO agent_event_subscription_intents VALUES(?,1) ON CONFLICT(id) DO UPDATE SET generation=generation+1',
        )
        .run(id);
      return (
        this.store.db
          .prepare('SELECT generation FROM agent_event_subscription_intents WHERE id=?')
          .get(id) as { generation: number }
      ).generation;
    });
    const authorize = () => {
      access?.require('material_read');
      revalidateAgentReceiverConnection(this.store.db, actor);
      const intent = this.store.db
        .prepare('SELECT generation FROM agent_event_subscription_intents WHERE id=?')
        .get(id) as { generation: number } | undefined;
      if (!intent || intent.generation !== generation || expiry <= at()) throw invalid();
    };
    // Refresh verification never disables an existing live subscription. Pending intents
    // fence unsubscribe/concurrent refresh while the former callback keeps receiving.
    if (!cached) await verifyCallback(this.sender, url, secret, id, authorize);
    this.store.atomic(() => {
      authorize();
      const sealed = this.encrypt(
        {
          url,
          secret,
          ...(previous && previous.secret !== secret
            ? {
                previousSecret: previous.secret,
                rotateUntil: new Date(Date.now() + 300000).toISOString(),
              }
            : previous?.previousSecret && previous.rotateUntil! > at()
              ? { previousSecret: previous.previousSecret, rotateUntil: previous.rotateUntil }
              : {}),
        },
        id,
      );
      this.store.db
        .prepare(
          `INSERT INTO agent_event_subscriptions (id,connection_id,connection_revision,participant_id,grant_id,identity_hash,generation,expires_at,revoked_at,private_body,verified_until,oauth_authority) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET connection_revision=excluded.connection_revision,generation=excluded.generation,expires_at=excluded.expires_at,revoked_at=NULL,private_body=excluded.private_body,verified_until=excluded.verified_until,oauth_authority=excluded.oauth_authority`,
        )
        .run(
          id,
          actor.connectionId,
          actor.connectionRevision,
          actor.participantId,
          actor.target.grantId,
          id,
          generation,
          expiry,
          null,
          sealed,
          new Date(Date.now() + 300000).toISOString(),
          access ? JSON.stringify(access.subscription) : null,
        );
    });
    return { id, refreshBefore: expiry, cursor: null, truncated: false };
  }
  unsubscribe(actor: AgentReceiverPrincipal, input: unknown, access?: OAuthReceiverAccess) {
    const { id } = this.identity(actor, input, false, access);
    this.store.atomic(() => {
      access?.require('material_read');
      revalidateAgentReceiverConnection(this.store.db, actor);
      this.store.db
        .prepare(
          'INSERT INTO agent_event_subscription_intents VALUES(?,1) ON CONFLICT(id) DO UPDATE SET generation=generation+1',
        )
        .run(id);
      this.store.db
        .prepare(
          'UPDATE agent_event_subscriptions SET revoked_at=?,generation=generation+1 WHERE id=? AND connection_id=?',
        )
        .run(at(), id, actor.connectionId);
      this.store.db
        .prepare(
          "UPDATE agent_event_deliveries SET state='suppressed' WHERE subscription_id=? AND state IN ('pending','unknown')",
        )
        .run(id);
    });
    return {};
  }
  private authority(s: Subscription, requestId: string) {
    const current = this.row(s.id);
    if (
      !current ||
      current.revoked_at ||
      current.expires_at <= at() ||
      current.generation !== s.generation
    )
      throw invalid();
    let actor: AgentReceiverPrincipal;
    if (s.oauth_authority) {
      if (!this.oauth) throw invalid(); // Restart without the opted-in verifier must not revive OAuth deliveries.
      actor = this.oauth.revalidateSubscription(
        JSON.parse(s.oauth_authority) as OAuthSubscriptionAuthority,
      );
      if (actor.connectionId !== s.connection_id) throw invalid();
    } else actor = agentReceiverConnectionById(this.store.db, s.connection_id);
    if (actor.connectionRevision !== s.connection_revision) throw invalid();
    this.receiver.get(actor, requestId); // Same finite request authority as tool reads, including current material/grant scope.
  }
  async idle() {
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  async drain(limit = 20) {
    if (this.busy) return;
    this.busy = true;
    try {
      const rows = this.store.db
        .prepare(
          "SELECT * FROM agent_event_deliveries WHERE state IN ('pending','unknown') AND next_at<=? ORDER BY sequence,id LIMIT ?",
        )
        .all(at(), Math.min(100, Math.max(1, limit))) as Delivery[];
      for (const d of rows) {
        const s = this.row(d.subscription_id);
        try {
          if (!s) throw invalid();
          this.authority(s, d.request_id);
        } catch {
          this.store.db
            .prepare("UPDATE agent_event_deliveries SET state='suppressed' WHERE id=?")
            .run(d.id);
          continue;
        }
        if (d.attempts >= 6) {
          this.store.db
            .prepare("UPDATE agent_event_deliveries SET state='failed' WHERE id=?")
            .run(d.id);
          continue;
        }
        let config: Private;
        try {
          config = this.decrypt(s!);
        } catch {
          continue;
        } // Missing restore key is a blocker, never discard pending events.
        this.store.db
          .prepare(
            "UPDATE agent_event_deliveries SET state='inflight',attempts=attempts+1 WHERE id=?",
          )
          .run(d.id);
        const body = JSON.stringify({
          eventId: d.id,
          name: EVENT_NAME,
          timestamp: d.occurred_at,
          data: { requestId: d.request_id },
          cursor: null,
        });
        const secrets = [
          config.secret,
          ...(config.previousSecret && config.rotateUntil! > at() ? [config.previousSecret] : []),
        ];
        let status: number | null = null,
          state = 'unknown';
        try {
          const result = await this.sender(
            config.url,
            body,
            { ...signedHeaders(d.id, body, secrets), 'X-MCP-Subscription-Id': s!.id },
            () => this.authority(s!, d.request_id),
          );
          status = result.status;
          state =
            status >= 200 && status < 300
              ? 'accepted'
              : status === 410 ||
                  status === 413 ||
                  (status >= 300 && status < 500 && status !== 408 && status !== 429)
                ? 'failed'
                : 'unknown';
        } catch {
          /* Lost response may already be received. Retry only this same event, no model start. */
        }
        this.store.db
          .prepare('UPDATE agent_event_deliveries SET state=?,last_status=?,next_at=? WHERE id=?')
          .run(
            state,
            status,
            new Date(Date.now() + Math.min(300000, 1000 * 2 ** d.attempts)).toISOString(),
            d.id,
          );
      }
    } finally {
      this.busy = false;
    }
  }
}
