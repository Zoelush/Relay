-- Rollback for 0086_saml: a SAML connection is turned off (enforcement first), since the earlier
-- code only speaks OIDC, and parked responses are cleared. The columns and audit records stay.
UPDATE sso_connections SET enforced=false,enabled=false WHERE protocol='saml' AND (enabled OR enforced);
UPDATE sso_logins SET saml_response=NULL,used_at=COALESCE(used_at,now()) WHERE saml_response IS NOT NULL OR (request_id IS NOT NULL AND used_at IS NULL);
