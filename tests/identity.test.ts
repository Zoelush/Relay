import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import {
  verifyIdentity,
  identityIssuer,
  wrapIdentityKey,
  unwrapIdentityKey,
} from "../server/identity";
const secret = new TextEncoder().encode(
  "test-only-randomish-secret-of-at-least-32-bytes",
);
const now = 1700000000000;
const policy = {
  workspaceId: "a",
  enforced: true,
  legacyHmacEnabled: false,
  keys: { current: secret, previous: secret },
};
async function token(
  kid = "current",
  key = secret,
  expiry = now / 1000 + 300,
  workspace = "a",
) {
  return new SignJWT({ email: "u@example.com", workspace_id: workspace })
    .setProtectedHeader({ alg: "HS256", kid })
    .setSubject("u")
    .setIssuer(identityIssuer(workspace))
    .setAudience("relay-messenger")
    .setIssuedAt(now / 1000)
    .setExpirationTime(expiry)
    .sign(key);
}
test("valid current and rotation keys work; forged, expired, cross-workspace and unsigned identities fail", async () => {
  for (const kid of ["current", "previous"])
    assert.equal(
      await verifyIdentity(
        { userId: "u", email: "u@example.com", jwt: await token(kid) },
        policy,
        now,
      ),
      true,
    );
  for (const jwt of [
    await token("current", new TextEncoder().encode("forged-secret")),
    await token("current", secret, now / 1000 - 1),
    await token("current", secret, now / 1000 + 300, "b"),
    await token("retired"),
  ]) {
    await assert.rejects(
      verifyIdentity({ userId: "u", email: "u@example.com", jwt }, policy, now),
    );
  }
  await assert.rejects(
    verifyIdentity({ userId: "u", email: "u@example.com" }, policy, now),
    /requires signed identity/,
  );
  await assert.rejects(
    verifyIdentity(
      { userId: "u", email: "other@example.com", jwt: await token() },
      policy,
      now,
    ),
    /claims do not match/,
  );
  assert.equal(
    await verifyIdentity(
      { userId: "u", email: "u@example.com" },
      { ...policy, enforced: false },
      now,
    ),
    false,
  );
  // Enforcement off must not turn an explicitly invalid proof into an accepted identity.
  await assert.rejects(
    verifyIdentity(
      { userId: "u", email: "u@example.com", jwt: await token("retired") },
      { ...policy, enforced: false },
      now,
    ),
  );
});
test("encrypted identity keys are bound to workspace and key ID", async () => {
  const master = "test-only-master-key-at-least-32-characters";
  const blob = await wrapIdentityKey(secret, master, "a", "current");
  assert.deepEqual(
    await unwrapIdentityKey(blob, master, "a", "current"),
    secret,
  );
  await assert.rejects(unwrapIdentityKey(blob, master, "b", "current"));
});
