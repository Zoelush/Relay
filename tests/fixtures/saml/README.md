# Test SAML identity provider key (phase 16, C4b)

`test-idp.key` and `test-idp.crt` are a throwaway, self-signed RSA key pair for the loopback
stand-in identity provider (`scripts/local-idp.ts`) and the tests. They protect nothing, are
public in this repository on purpose, and must never be used for anything real.
