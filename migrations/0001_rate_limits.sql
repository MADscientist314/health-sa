-- Requests to the Claude proxy, for its rate limits. bucket is 'ip:<address>' or
-- 'user:<Supabase user id>'; at is epoch milliseconds. Rows older than a day are
-- deleted as new requests arrive, so the table stays small.
CREATE TABLE rate_events (
  bucket TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE INDEX rate_events_bucket ON rate_events (bucket, at);
CREATE INDEX rate_events_at ON rate_events (at);
