-- Messenger settings, step M3: failed identity verifications, so Settings can show what's wrong
-- with an installation. Counted per brand, reason and hour, and kept for seven days. No user ids,
-- emails or tokens are kept: the reason is the generic message the messenger was given. Additive.
CREATE TABLE identity_failures (
 workspace_id text NOT NULL, brand_id text NOT NULL, reason text NOT NULL CHECK(length(reason)<=200),
 hour timestamptz NOT NULL, count integer NOT NULL DEFAULT 1, last_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,brand_id,reason,hour));
ALTER TABLE identity_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_failures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON identity_failures USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
