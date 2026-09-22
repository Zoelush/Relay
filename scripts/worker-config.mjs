import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
try {
  process.loadEnvFile(".dev.vars");
} catch {}
const required = [
  "HYPERDRIVE_ID",
  "RELAY_PUBLIC_ORIGIN",
  "RELAY_QUEUE_NAME",
  "RELAY_DLQ_NAME",
  "RELAY_WORKSPACE_KV_ID",
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length)
  throw new Error(
    "Missing local configuration names: " +
      missing.join(", ") +
      ". Values are never printed.",
  );
if (!/^[a-f0-9]{32}$/i.test(process.env.HYPERDRIVE_ID))
  throw new Error("HYPERDRIVE_ID format is invalid.");
const config = {
  name: "relay-core",
  main: resolve("workers/relay.ts"),
  compatibility_date: "2026-05-15",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: false,
  assets: {
    directory: resolve("public"),
    binding: "ASSETS",
    run_worker_first: true,
  },
  hyperdrive: [{ binding: "HYPERDRIVE", id: process.env.HYPERDRIVE_ID }],
  durable_objects: {
    bindings: [
      { name: "RELAY_HUB", class_name: "RelayHub" },
      { name: "CONVERSATION_CLOCK", class_name: "ConversationClock" },
    ],
  },
  migrations: [
    { tag: "relay-v1", new_sqlite_classes: ["RelayHub", "ConversationClock"] },
  ],
  kv_namespaces: [
    { binding: "WORKSPACE_REGISTRY", id: process.env.RELAY_WORKSPACE_KV_ID },
  ],
  queues: {
    producers: [
      { binding: "JOBS", queue: process.env.RELAY_QUEUE_NAME },
      { binding: "JOBS_DLQ", queue: process.env.RELAY_DLQ_NAME },
    ],
    consumers: [
      {
        queue: process.env.RELAY_QUEUE_NAME,
        max_batch_size: 10,
        max_batch_timeout: 1,
        max_retries: 5,
        dead_letter_queue: process.env.RELAY_DLQ_NAME,
      },
      {
        queue: process.env.RELAY_DLQ_NAME,
        max_batch_size: 10,
        max_batch_timeout: 1,
        max_retries: 5,
      },
    ],
  },
  triggers: { crons: ["* * * * *"] },
  vars: {
    RELAY_ENABLED: "false",
    ATTACHMENTS_ENABLED: "false",
    PUBLIC_ORIGIN: process.env.RELAY_PUBLIC_ORIGIN,
    DEAD_LETTER_QUEUE_NAME: process.env.RELAY_DLQ_NAME,
  },
  observability: { enabled: true },
};
if (process.env.R2_QUARANTINE_BUCKET && process.env.R2_CLEAN_BUCKET) {
  config.r2_buckets = [
    {
      binding: "ATTACHMENT_QUARANTINE",
      bucket_name: process.env.R2_QUARANTINE_BUCKET,
    },
    { binding: "ATTACHMENT_CLEAN", bucket_name: process.env.R2_CLEAN_BUCKET },
  ];
}
if (process.env.RELAY_SCANNER_SERVICE) {
  config.services = [
    { binding: "SCANNER", service: process.env.RELAY_SCANNER_SERVICE },
  ];
}
if (process.env.RELAY_PREVIEW_SERVICE) {
  (config.services ??= []).push({
    binding: "IMAGE_PREVIEW",
    service: process.env.RELAY_PREVIEW_SERVICE,
  });
}
await mkdir(".wrangler", { recursive: true });
await writeFile(
  ".wrangler/relay-private.json",
  JSON.stringify(config, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(
  "Wrote ignored private Worker configuration. Both feature flags remain off. No resources were provisioned or deployed.",
);
