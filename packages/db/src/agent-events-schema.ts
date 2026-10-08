/** Delivery observations only. Assistance remains the sole business state. */
export const AGENT_EVENTS_MIGRATION = {
  version: 41,
  sql: `
CREATE TABLE agent_event_subscription_intents (id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
CREATE TABLE agent_event_subscriptions (
 id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES agent_receiver_connections(id),
 connection_revision INTEGER NOT NULL, participant_id TEXT NOT NULL, grant_id TEXT NOT NULL,
 identity_hash TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL, expires_at TEXT NOT NULL,
 revoked_at TEXT, private_body TEXT NOT NULL, verified_until TEXT NOT NULL
);
CREATE TABLE agent_event_deliveries (
 id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES agent_event_subscriptions(id),
 sequence INTEGER NOT NULL, request_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','inflight','accepted','unknown','failed','suppressed')),
 attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, last_status INTEGER,
 UNIQUE(subscription_id,sequence)
);
CREATE INDEX agent_events_due ON agent_event_deliveries(state,next_at);
CREATE TRIGGER agent_events_enqueue AFTER INSERT ON outbox
 WHEN NEW.assistance_id IS NOT NULL BEGIN
 INSERT OR IGNORE INTO agent_event_deliveries
 (id,subscription_id,sequence,request_id,occurred_at,state,next_at)
 SELECT s.id || ':' || NEW.sequence,s.id,NEW.sequence,r.request_id,NEW.created_at,'pending',NEW.created_at
 FROM agent_event_subscriptions s JOIN assistance_agent_requests r
 ON r.recipient_participant_id=s.participant_id AND r.grant_id=s.grant_id
 WHERE r.assistance_id=NEW.assistance_id AND s.revoked_at IS NULL AND s.expires_at>NEW.created_at;
END;
`,
};
