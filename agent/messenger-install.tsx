import { useState } from "react";
import { Card } from "./settings-ui";

/**
 * Settings › Messenger: installing it and verifying signed-in customers (messenger settings M3;
 * docs/MESSENGER_SETTINGS_STEP3.md). Snippets per framework, for visitors or signed-in users;
 * where the messenger has run in the last seven days; a guided identity set-up with server
 * examples, and the recent verification failures (reasons and counts only).
 */
export type InstallStatus = {
  origins: { origin: string; sessions: number; verified: number }[];
  failures: { reason: string; count: number; lastAt: string }[];
};
const FRAMEWORKS = [
  ["html", "HTML"],
  ["react", "React"],
  ["vue", "Vue"],
  ["angular", "Angular"],
  ["wordpress", "WordPress"],
  ["gtm", "Google Tag Manager"],
] as const;
type Framework = (typeof FRAMEWORKS)[number][0];
const SERVERS = [
  ["node", "Node"],
  ["python", "Python"],
  ["php", "PHP"],
  ["ruby", "Ruby"],
  ["go", "Go"],
  ["java", "Java"],
] as const;
type Server = (typeof SERVERS)[number][0];

/** The install code for a framework, for visitors or for signed-in users. */
export function installCode(
  framework: Framework,
  signedIn: boolean,
  o: { api: string; workspaceId: string; brandId: string },
) {
  const user = signedIn
    ? `
  // Signed-in customers: their id, email and a token signed by your server (see Identity).
  user: { userId: user.id, email: user.email, name: user.name, jwt: relayToken },`
    : "";
  const boot = `Relay('boot', {
  api: '${o.api}',
  workspaceId: '${o.workspaceId}',
  brandId: '${o.brandId}',
  locale: document.documentElement.lang,${user}
});`;
  const queue = `window.Relay = window.Relay || function () {
  (window.Relay.q = window.Relay.q || []).push(arguments);
};`;
  const loader = `${o.api}/messenger/loader.js`;
  switch (framework) {
    case "html":
      return `<!-- support-boot.js, served from your own site -->
${queue}
${boot}

<!-- In each page, before </body> -->
<script src="/support-boot.js" defer></script>
<script src="${loader}" async></script>`;
    case "react":
      return `import { useEffect } from "react";

// Render once, near the root of your app${signedIn ? ", with the signed-in user and their token" : ""}.
export function RelayMessenger(${signedIn ? "{ user, relayToken }" : ""}) {
  useEffect(() => {
    ${queue.replace(/\n/g, "\n    ")}
    window.${boot.replace(/\n/g, "\n    ")}
    const script = document.createElement("script");
    script.src = "${loader}";
    script.async = true;
    document.body.appendChild(script);
    return () => window.Relay("destroy");
  }, [${signedIn ? "user, relayToken" : ""}]);
  return null;
}`;
    case "vue":
      return `<script setup>
import { onMounted, onBeforeUnmount } from "vue";
${signedIn ? 'const props = defineProps(["user", "relayToken"]);\nconst { user, relayToken } = props;\n' : ""}
onMounted(() => {
  ${queue.replace(/\n/g, "\n  ")}
  window.${boot.replace(/\n/g, "\n  ")}
  const script = document.createElement("script");
  script.src = "${loader}";
  script.async = true;
  document.body.appendChild(script);
});
onBeforeUnmount(() => window.Relay("destroy"));
</script>`;
    case "angular":
      return `// app.component.ts
import { Component, OnDestroy, OnInit } from "@angular/core";

declare global { interface Window { Relay: any } }

@Component({ selector: "app-root", templateUrl: "./app.component.html" })
export class AppComponent implements OnInit, OnDestroy {${signedIn ? '\n  user = /* the signed-in user */ null as any;\n  relayToken = /* from your server */ "";' : ""}
  ngOnInit() {${signedIn ? "\n    const { user, relayToken } = this;" : ""}
    ${queue.replace(/\n/g, "\n    ")}
    window.${boot.replace(/\n/g, "\n    ")}
    const script = document.createElement("script");
    script.src = "${loader}";
    script.async = true;
    document.body.appendChild(script);
  }
  ngOnDestroy() {
    window.Relay("destroy");
  }
}`;
    case "wordpress":
      return `<?php
// In your theme's functions.php (or a small plugin): the messenger on every page.
add_action('wp_enqueue_scripts', function () {
  wp_register_script('relay-messenger', '${loader}', [], null, ['strategy' => 'async', 'in_footer' => true]);
  wp_add_inline_script('relay-messenger', <<<JS
${queue}
${signedIn ? boot.replace("user: { userId: user.id, email: user.email, name: user.name, jwt: relayToken },", "user: RELAY_USER, // printed by your server for signed-in visitors") : boot}
JS, 'before');
  wp_enqueue_script('relay-messenger');
});`;
    case "gtm":
      return `<!-- Google Tag Manager: a Custom HTML tag, triggered on All Pages. -->
<script>
${queue}
${signedIn ? boot.replace("user: { userId: user.id, email: user.email, name: user.name, jwt: relayToken },", "user: {{Relay user}}, // a Data Layer variable your site sets for signed-in visitors") : boot}
</script>
<script src="${loader}" async></script>`;
  }
}

/** A server example that signs a customer's identity token. */
export function serverCode(server: Server, workspaceId: string, kid: string) {
  const iss = `relay-customer:${workspaceId}`;
  switch (server) {
    case "node":
      return `import { SignJWT } from "jose";

const secret = new TextEncoder().encode(process.env.RELAY_IDENTITY_SECRET);

export function relayToken(user) {
  return new SignJWT({ email: user.email, workspace_id: "${workspaceId}" })
    .setProtectedHeader({ alg: "HS256", kid: "${kid}" })
    .setIssuer("${iss}")
    .setAudience("relay-messenger")
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
}`;
    case "python":
      return `import os, time
import jwt  # PyJWT

def relay_token(user):
    now = int(time.time())
    claims = {
        "iss": "${iss}",
        "aud": "relay-messenger",
        "sub": str(user.id),
        "email": user.email,
        "workspace_id": "${workspaceId}",
        "iat": now,
        "exp": now + 3600,
    }
    return jwt.encode(claims, os.environ["RELAY_IDENTITY_SECRET"], algorithm="HS256", headers={"kid": "${kid}"})`;
    case "php":
      return `<?php
use Firebase\\JWT\\JWT; // firebase/php-jwt

function relay_token($user): string {
  $now = time();
  return JWT::encode([
    'iss' => '${iss}',
    'aud' => 'relay-messenger',
    'sub' => (string) $user->id,
    'email' => $user->email,
    'workspace_id' => '${workspaceId}',
    'iat' => $now,
    'exp' => $now + 3600,
  ], getenv('RELAY_IDENTITY_SECRET'), 'HS256', '${kid}');
}`;
    case "ruby":
      return `require "jwt"

def relay_token(user)
  now = Time.now.to_i
  claims = {
    iss: "${iss}", aud: "relay-messenger", sub: user.id.to_s, email: user.email,
    workspace_id: "${workspaceId}", iat: now, exp: now + 3600,
  }
  JWT.encode(claims, ENV.fetch("RELAY_IDENTITY_SECRET"), "HS256", { kid: "${kid}" })
end`;
    case "go":
      return `import (
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func relayToken(id, email string) (string, error) {
	now := time.Now()
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"iss": "${iss}", "aud": "relay-messenger", "sub": id, "email": email,
		"workspace_id": "${workspaceId}", "iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
	})
	token.Header["kid"] = "${kid}"
	return token.SignedString([]byte(os.Getenv("RELAY_IDENTITY_SECRET")))
}`;
    case "java":
      return `// io.jsonwebtoken:jjwt-api 0.12+
String relayToken(String id, String email) {
  Instant now = Instant.now();
  return Jwts.builder()
      .header().keyId("${kid}").and()
      .issuer("${iss}")
      .audience().add("relay-messenger").and()
      .subject(id)
      .claim("email", email)
      .claim("workspace_id", "${workspaceId}")
      .issuedAt(Date.from(now))
      .expiration(Date.from(now.plusSeconds(3600)))
      .signWith(Keys.hmacShaKeyFor(System.getenv("RELAY_IDENTITY_SECRET").getBytes(StandardCharsets.UTF_8)), Jwts.SIG.HS256)
      .compact();
}`;
  }
}

function Tabs<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="pg-settings-tabs" role="tablist" aria-label={label}>
      {options.map(([v, name]) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={value === v}
          onClick={() => onChange(v)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
function Code({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="pg-settings-code-block">
      <pre className="pg-settings-code" aria-label={label}>
        {code}
      </pre>
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard
            ?.writeText(code)
            .then(() => setCopied(true))
            .catch(() => undefined)
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function InstallCard({
  api,
  workspaceId,
  brandId,
  status,
}: {
  api: string;
  workspaceId: string;
  brandId: string;
  status: InstallStatus | undefined;
}) {
  const [framework, setFramework] = useState<Framework>("html");
  const [signedIn, setSignedIn] = useState(false);
  return (
    <Card
      title="Install"
      description="Add the messenger to every page of the websites listed under General › Keep your Messenger secure. Single-page apps need nothing more: the messenger follows navigation."
    >
      <div
        className="pg-settings-install-status"
        role="status"
        aria-label="Install status"
      >
        {!status?.origins.length ? (
          <p className="pg-muted">
            Not seen on any website in the last 7 days.
          </p>
        ) : (
          <ul className="pg-settings-list" aria-label="Seen on">
            {status.origins.map((o) => (
              <li key={o.origin}>
                <span>
                  <strong>{o.origin}</strong>
                  <small className="pg-muted">
                    {o.sessions} {o.sessions === 1 ? "visit" : "visits"} in the
                    last 7 days ·{" "}
                    {o.verified
                      ? `${o.verified} by verified signed-in customers`
                      : "no verified signed-in customers yet"}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Tabs
        label="Framework"
        options={FRAMEWORKS}
        value={framework}
        onChange={setFramework}
      />
      <div
        className="pg-settings-checks"
        role="radiogroup"
        aria-label="Who uses the site"
      >
        <label>
          <input
            type="radio"
            name="install-who"
            checked={!signedIn}
            onChange={() => setSignedIn(false)}
          />
          Visitors (no sign-in)
        </label>
        <label>
          <input
            type="radio"
            name="install-who"
            checked={signedIn}
            onChange={() => setSignedIn(true)}
          />
          Signed-in customers
        </label>
      </div>
      <Code
        label="Install snippet"
        code={installCode(framework, signedIn, { api, workspaceId, brandId })}
      />
    </Card>
  );
}

export function IdentityGuide({
  workspaceId,
  keys,
  status,
}: {
  workspaceId: string;
  keys: { kid: string }[];
  status: InstallStatus | undefined;
}) {
  const [server, setServer] = useState<Server>("node");
  const kid = keys[0]?.kid ?? "<KEY_ID>";
  return (
    <Card
      title="Set up identity verification"
      description="Signed-in customers see their history across devices, and nobody can read their conversations by claiming their email, once your server signs who they are."
    >
      <ol className="pg-settings-steps">
        <li>
          <strong>Keep the signing secret on your server.</strong> Your Relay
          operator gives you the secret for key <code>{kid}</code>
          {keys.length > 1
            ? ` (or ${keys
                .slice(1)
                .map((k) => k.kid)
                .join(", ")})`
            : ""}
          . Store it as <code>RELAY_IDENTITY_SECRET</code>; never put it in
          pages or code that reaches a browser.
        </li>
        <li>
          <strong>Sign a token for each signed-in customer.</strong> HS256, with
          the key id in the header; issuer{" "}
          <code>relay-customer:{workspaceId}</code>, audience{" "}
          <code>relay-messenger</code>, their id as subject, their email,{" "}
          <code>workspace_id</code>, and an expiry within one hour.
          <Tabs
            label="Server language"
            options={SERVERS}
            value={server}
            onChange={setServer}
          />
          <Code
            label="Server example"
            code={serverCode(server, workspaceId, kid)}
          />
        </li>
        <li>
          <strong>Pass it to the messenger</strong> as <code>user.jwt</code>,
          with the same id and email (the Install snippet for signed-in
          customers shows where). When it expires the messenger asks for a new
          one through the <code>relay:identityRequired</code> event.
        </li>
        <li>
          <strong>Check it works.</strong> Verified visits show under Install;
          failures show here.
        </li>
      </ol>
      <h4 className="pg-settings-subhead">
        Verification failures in the last 7 days
      </h4>
      {!status?.failures.length ? (
        <p className="pg-muted">None.</p>
      ) : (
        <ul className="pg-settings-list" aria-label="Verification failures">
          {status.failures.map((f) => (
            <li key={f.reason}>
              <span>
                <strong>{f.reason}</strong>
                <small className="pg-muted">
                  {f.count} {f.count === 1 ? "time" : "times"} · last{" "}
                  {new Date(f.lastAt).toLocaleString()}
                </small>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
