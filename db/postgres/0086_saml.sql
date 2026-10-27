-- SAML 2.0 single sign-on (phase 16, step C4b; docs/SECURITY_STEP6.md). Additive.
-- The workspace's one connection may be SAML instead of OIDC, keeping C4a's domains, group
-- mappings, identities and enforcement. For SAML: the provider's SSO URL, its entity ID (in
-- `issuer`) and its signing certificate (public). OIDC's own columns become optional, each
-- protocol's required by a check. A login keeps its request's ID (for InResponseTo) and, between
-- the provider's POST and the browser's return, the response it brought.

ALTER TABLE sso_connections DROP CONSTRAINT sso_connections_protocol_check;
ALTER TABLE sso_connections ADD CONSTRAINT sso_connections_protocol_check CHECK(protocol IN ('oidc','saml'));
ALTER TABLE sso_connections ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE sso_connections ALTER COLUMN authorization_endpoint DROP NOT NULL;
ALTER TABLE sso_connections ALTER COLUMN token_endpoint DROP NOT NULL;
ALTER TABLE sso_connections ALTER COLUMN jwks_uri DROP NOT NULL;
ALTER TABLE sso_connections ADD COLUMN entry_point text;
ALTER TABLE sso_connections ADD COLUMN idp_cert text CHECK(length(idp_cert) <= 20000);
ALTER TABLE sso_connections ADD CONSTRAINT sso_connections_protocol_fields CHECK(
 (protocol='oidc' AND client_id IS NOT NULL AND authorization_endpoint IS NOT NULL AND token_endpoint IS NOT NULL AND jwks_uri IS NOT NULL)
 OR (protocol='saml' AND entry_point IS NOT NULL AND idp_cert IS NOT NULL));

ALTER TABLE sso_logins ADD COLUMN request_id text;
ALTER TABLE sso_logins ADD COLUMN saml_response text CHECK(length(saml_response) <= 300000);

-- The audit trigger also follows the protocol, the SSO URL and the certificate.
DROP TRIGGER audit ON sso_connections;
CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE OF protocol,name,issuer,client_id,client_secret_sealed,entry_point,idp_cert,groups_claim,enabled,enforced ON sso_connections FOR EACH ROW EXECUTE FUNCTION audit_row('sso','sso_connection','id','name');
