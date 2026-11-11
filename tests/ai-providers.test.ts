import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { runJob, type Job } from "../server/jobs";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { memoryVectorStore, runIndex, scheduleIndex, testEmbedder, type IndexEnvironment } from "../server/knowledge-index";
import { standInAnswerModel, standInClassifier, standInReranker, type AnswerModel, type ClassifierPort, type Served } from "../server/ai-model";
import { runAiReply, type AiEnvironment } from "../server/ai-agent";
import { connectionModels, failingModels, providerFailure, routed, type ProviderPolicy } from "../server/ai-adapters";
import { keySourceOf, normalizeBaseUrl, runProviderTest, testFailure, TEST_REQUEST, withWorkspaceModels, type ProviderEnvironment } from "../server/ai-providers";
import { seal } from "../server/connectors";
import { changeLimits } from "../server/limits";
import { meterTotal, periodFor } from "../server/meters";
import { METER_IDS } from "../lib/meters";
import { UNIT_PRICES } from "../lib/plans";

/** AI providers (phase 16, C9d; docs/SECURITY_STEP19.md). Every provider is a stub: never the network. */
type Sent = { url: string; headers: Headers; body: any };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const chat = (content: unknown, model = "gpt-6-luna-2026-10-01") => json({ model, choices: [{ message: { content }, finish_reason: "stop" }] });
const REPLY = '{"kind":"answer","sentences":[{"text":"Monday to Friday, from 9am to 5pm.","sources":["p1"]}]}';
const CLASSIFIED = '{"wants_human":false,"sentiment":"neutral","topic":null,"guidance":null,"spam":null,"specialist":null}';
function stub(respond: (s: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const policy: ProviderPolicy = {
    fetch: (async (url: string, init: RequestInit) => {
      const s = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
      sent.push(s);
      return respond(s);
    }) as typeof fetch,
  };
  return { sent, policy };
}

test("adapters: OpenAI, DeepSeek, a custom endpoint, Gemini and Claude carry Zoe's prompt and bring back her reply; failures say why by status; the router falls back only when the primary fails", async () => {
  let respond: (s: Sent) => Response | Promise<Response> = () => chat(REPLY);
  const { sent, policy } = stub((s) => respond(s));
  const request = TEST_REQUEST;
  let served: Served | null = null;
  const take = (s: Served) => (served = s);

  // OpenAI: Chat Completions, the key as a bearer token, no temperature, max_completion_tokens, JSON mode.
  const openai = connectionModels({ provider: "openai", key: "sk-test-openai-1234", model: "gpt-6-luna", classifierModel: "gpt-5.4-mini", baseUrl: null }, policy);
  assert.deepEqual(await openai.model.answer(request, take), { kind: "answer", sentences: [{ text: "Monday to Friday, from 9am to 5pm.", sources: ["p1"] }] });
  assert.deepEqual(served, { provider: "openai", model: "gpt-6-luna-2026-10-01", keySource: "workspace", failover: null });
  let s = sent.at(-1)!;
  assert.equal(s.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(s.headers.get("authorization"), "Bearer sk-test-openai-1234");
  assert.deepEqual(
    [s.body.model, s.body.messages.map((m: { role: string }) => m.role), s.body.max_completion_tokens, s.body.max_tokens, s.body.temperature, s.body.response_format],
    ["gpt-6-luna", ["system", "user"], 8000, undefined, undefined, { type: "json_object" }],
  );
  assert.match(s.body.messages[0].content, /^You are Zoe, a customer support assistant/);
  assert.match(s.body.messages[1].content, /<question>\nWhen can I reach the support team\?\n<\/question>/);
  // Its classifier is the smaller model.
  respond = () => chat(CLASSIFIED.replace("false", "true"));
  assert.equal((await openai.classify.classify({ message: "A person, please", history: [], locale: "en" })).wantsHuman, true);
  assert.equal(sent.at(-1)!.body.model, "gpt-5.4-mini");
  // Failures: by status only (never the provider's text), a refusal, and a reply that isn't JSON.
  respond = () => json({ error: { message: "Incorrect API key provided: sk-test...1234" } }, 401);
  const refusedKey = await openai.model.answer(request).catch((e) => e);
  assert.equal(refusedKey.message, "The answering model returned 401.");
  assert.equal(refusedKey.details.status, 401);
  assert.match(testFailure(refusedKey), /refused the key \(401\)/);
  respond = () => json({ choices: [{ message: { content: null, refusal: "I can't help with that." }, finish_reason: "stop" }] });
  await assert.rejects(openai.model.answer(request), /declined to answer/);
  respond = () => chat("Sure! Here you go.");
  await assert.rejects(openai.model.answer(request), /expected form/);

  // DeepSeek: its own address, max_tokens, low reasoning effort, JSON mode; the classifier is the same model.
  respond = (x) => chat(/You classify/.test(x.body.messages[0].content) ? CLASSIFIED : REPLY, "deepseek-flash");
  const deepseek = connectionModels({ provider: "deepseek", key: "sk-deepseek-5678", model: "deepseek-flash", classifierModel: null, baseUrl: null }, policy);
  assert.equal((await deepseek.model.answer(request)).kind, "answer");
  s = sent.at(-1)!;
  assert.deepEqual(
    [s.url, s.body.max_tokens, s.body.max_completion_tokens, s.body.reasoning_effort, s.body.response_format],
    ["https://api.deepseek.com/chat/completions", 8000, undefined, "low", { type: "json_object" }],
  );
  await deepseek.classify.classify({ message: "Hi", history: [], locale: "en" });
  assert.deepEqual([sent.at(-1)!.body.model, sent.at(-1)!.body.max_tokens], ["deepseek-flash", 2000]);

  // A custom endpoint: its base URL plus /chat/completions, no JSON mode (not every endpoint has it).
  respond = () => chat("```json\n" + REPLY + "\n```", "openai/gpt-6-luna");
  const conn = { provider: "custom" as const, key: "gw-key-0000", model: "openai/gpt-6-luna", classifierModel: null, baseUrl: "https://gateway.example/v1" };
  assert.equal((await connectionModels(conn, policy).model.answer(request)).kind, "answer");
  s = sent.at(-1)!;
  assert.deepEqual([s.url, s.body.response_format, s.body.max_tokens], ["https://gateway.example/v1/chat/completions", undefined, 8000]);
  // A private address is refused before anything is sent.
  const before = sent.length;
  await assert.rejects(connectionModels({ ...conn, baseUrl: "http://127.0.0.1:8080/v1" }, policy).model.answer(request), /public https address/);
  assert.equal(sent.length, before);
  assert.equal(normalizeBaseUrl("https://gateway.example/v1/chat/completions/"), "https://gateway.example/v1");
  for (const bad of ["http://gateway.example/v1", "https://10.0.0.5/v1", "https://localhost/v1", "https://gateway.example/v1?key=x", "https://user:pass@gateway.example/v1", ""])
    assert.throws(() => normalizeBaseUrl(bad), /https base URL/, bad);

  // Gemini: generateContent with the model in the path, the key in its header, JSON as the response type; thoughts are left out.
  respond = () => json({ modelVersion: "gemini-3.8-flash-001", candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Let me think.", thought: true }, { text: REPLY }] } }] });
  const gemini = connectionModels({ provider: "gemini", key: "AIza-test-9999", model: "gemini-3.8-flash", classifierModel: null, baseUrl: null }, policy);
  served = null;
  assert.equal((await gemini.model.answer(request, take)).kind, "answer");
  s = sent.at(-1)!;
  assert.equal(s.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
  assert.deepEqual([s.headers.get("x-goog-api-key"), s.headers.get("authorization")], ["AIza-test-9999", null]);
  assert.match(s.body.systemInstruction.parts[0].text, /^You are Zoe/);
  assert.deepEqual([s.body.contents[0].role, s.body.generationConfig.responseMimeType, s.body.generationConfig.temperature], ["user", "application/json", undefined]);
  assert.equal((served as Served | null)?.model, "gemini-3.8-flash-001");
  respond = () => json({ candidates: [{ finishReason: "SAFETY" }] });
  await assert.rejects(gemini.model.answer(request), /declined/);
  respond = () => json({ promptFeedback: { blockReason: "SAFETY" } });
  await assert.rejects(gemini.model.answer(request), /declined/);

  // Claude with the workspace's own key: Anthropic's SDK, the chosen model, recorded as the workspace's key.
  // The environment's ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN never redirect the key or add another.
  respond = () => json({ model: "claude-haiku-5-5", stop_reason: "end_turn", content: [{ type: "text", text: REPLY }] });
  const saved = { base: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN };
  process.env.ANTHROPIC_BASE_URL = "https://elsewhere.example";
  process.env.ANTHROPIC_AUTH_TOKEN = "someone-elses-token";
  const claude = connectionModels({ provider: "anthropic", key: "sk-ant-test-abcd", model: "claude-haiku-5-5", classifierModel: null, baseUrl: null }, policy);
  for (const [k, v] of [["ANTHROPIC_BASE_URL", saved.base], ["ANTHROPIC_AUTH_TOKEN", saved.token]] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  served = null;
  assert.equal((await claude.model.answer(request, take)).kind, "answer");
  s = sent.at(-1)!;
  assert.deepEqual([s.url, s.headers.get("authorization"), s.body.model, s.body.output_config.effort, s.body.fallbacks], ["https://api.anthropic.com/v1/messages", "Bearer sk-ant-test-abcd", "claude-haiku-5-5", "medium", undefined]);
  assert.deepEqual(served, { provider: "anthropic", model: "claude-haiku-5-5", keySource: "workspace", failover: null });

  // No answer in time is a timeout (the limit is 30 seconds; a test shortens it).
  const hanging = connectionModels({ provider: "openai", key: "sk-test-openai-1234", model: "gpt-6-luna", classifierModel: null, baseUrl: null }, {
    timeoutMs: 50,
    fetch: ((_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))) as typeof fetch,
  });
  const late = await hanging.model.answer(request).catch((e) => e);
  assert.equal(late.code, "MODEL_TIMEOUT");
  assert.match(testFailure(late), /didn't answer within 30 seconds/);

  // The router: the fallback only when the primary fails, told which primary failed and why.
  const answering = (provider: string, model: string, fn: AnswerModel["answer"]): AnswerModel => ({ model, provider, keySource: "workspace", answer: fn });
  const down = answering("openai", "gpt-6-luna", async () => {
    throw providerFailure(503, "answering model");
  });
  const spare = answering("anthropic", "claude-haiku-5-5", async (_r, s2) => {
    s2?.({ provider: "anthropic", model: "claude-haiku-5-5", keySource: "workspace", failover: null });
    return { kind: "unknown" };
  });
  served = null;
  assert.deepEqual(await routed(down, spare).answer(request, take), { kind: "unknown" });
  assert.deepEqual(served, { provider: "anthropic", model: "claude-haiku-5-5", keySource: "workspace", failover: "openai gpt-6-luna: The answering model returned 503." });
  let asked = false;
  const up = answering("openai", "gpt-6-luna", async (_r, s2) => {
    s2?.({ provider: "openai", model: "gpt-6-luna", keySource: "workspace", failover: null });
    return { kind: "unknown" };
  });
  const unused = answering("anthropic", "claude-haiku-5-5", async () => {
    asked = true;
    return { kind: "unknown" };
  });
  served = null;
  await routed(up, unused).answer(request, take);
  assert.deepEqual([asked, (served as Served | null)?.provider, (served as Served | null)?.failover], [false, "openai", null]);
  await assert.rejects(routed(down, failingModels("Gemini's key can't be read.", "workspace", "gemini").model).answer(request), /Gemini's key can't be read/);
  assert.equal(routed(down, null), down, "no fallback: the primary as it is");
  // The classifier routes the same way.
  const classifyDown: ClassifierPort = { model: "gpt-6-luna", provider: "openai", keySource: "workspace" as const, classify: async () => Promise.reject(providerFailure(500, "classifier")) };
  const classifySpare: ClassifierPort = { model: "deepseek-flash", provider: "deepseek", keySource: "workspace" as const, classify: async () => ({ wantsHuman: true, sentiment: "neutral" as const, topic: null, guidance: null, spam: null, specialist: null }) };
  served = null;
  assert.equal((await routed(classifyDown, classifySpare).classify({ message: "x", history: [], locale: "en" }, take)).wantsHuman, true);
  assert.deepEqual([(served as Served | null)?.provider, (served as Served | null)?.failover], ["deepseek", "openai gpt-6-luna: The classifier returned 500."]);
});

test("AI providers: managers connect a provider (its key sealed, never returned), test it with no customer data and choose a primary and fallback; Zoe then answers with the workspace's providers, never Relay's key, recording who served each call; own-key resolutions are their own meter and limit; per workspace; rollback", async () => {
  const db = await testDatabase();
  const index: IndexEnvironment = { embedders: [testEmbedder()], vectors: memoryVectorStore() };
  // Relay's own AI, counted: a workspace with a primary never uses it.
  let relayCalls = 0;
  const relayModel: AnswerModel = {
    ...standInAnswerModel(),
    answer: async (r, s) => {
      relayCalls++;
      return standInAnswerModel().answer(r, s);
    },
  };
  // The providers: OpenAI and Claude stubs, each set to answer, fail or refuse the key.
  const mode: Record<string, "ok" | "500" | "401"> = { openai: "ok", anthropic: "ok" };
  const { sent, policy } = stub((x) => {
    const provider = x.url.startsWith("https://api.anthropic.com") ? "anthropic" : "openai";
    if (mode[provider] !== "ok") return json({ error: { message: "nope" } }, Number(mode[provider]));
    if (provider === "anthropic") {
      const text = /You classify/.test(x.body.system) ? CLASSIFIED : x.body.messages[0].content.includes("[p1]") ? REPLY.replace("Monday to Friday, from 9am to 5pm.", "Refunds take five working days.") : '{"kind":"unknown"}';
      return json({ model: x.body.model, stop_reason: "end_turn", content: [{ type: "text", text }] });
    }
    const system = x.body.messages[0].content as string;
    return chat(/You classify/.test(system) ? CLASSIFIED : REPLY.replace("Monday to Friday, from 9am to 5pm.", "Refunds take five working days."));
  });
  const providers: ProviderEnvironment = { key: "c".repeat(40), policy };
  const ai: AiEnvironment = { model: relayModel, rerank: standInReranker(), index, classify: standInClassifier(), providers };
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
    knowledgeIndex: index,
    ai,
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) => tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "knowledge.index": (job: Job) => runIndex(db.connect, index, job),
    "ai.reply": (job: Job) => runAiReply(db.connect, ai, job),
    "ai.provider.test": (job: Job) => runProviderTest(db.connect, providers, job),
  };
  const drain = async (kind: string, w = "a") => {
    for (let i = 0; i < 50; i++) {
      const job = (await sql<{ id: string }>(w, "SELECT id FROM jobs WHERE kind=$1 AND state IN ('queued','running') ORDER BY created_at LIMIT 1", [kind]))[0];
      if (!job) return;
      const r = await runJob(db.connect, w, job.id, handlers);
      if (r.state === "queued" && !(r as { continued?: boolean }).continued) return;
    }
  };
  const agent = async (path: string, data?: unknown, principal = "owner-a", workspace = "a") => {
    const response = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: { origin: "https://app.test", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      principal,
      { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: workspace, RELAY_BRIDGE_SECRET: env.bridgeSecret },
      (r) => handleApi(r, env),
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  let n = 0;
  const start = async (text: string) => {
    const r = await tenant(db.connect, "a", async (q) => {
      const identity = await getIdentity(q, "a", "anonymous", "customer-" + ++n);
      const started = (await command(q, "a", { type: "contact", identityId: identity.identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text })) as { conversationId: string };
      return { id: started.conversationId, identityId: identity.identityId };
    });
    await drain("ai.reply");
    return r;
  };
  const calls = (conversationId: string) =>
    sql<{ kind: string; provider: string | null; model: string; key_source: string; failover: string | null }>(
      "a",
      "SELECT kind,provider,model,key_source,failover FROM ai_model_calls WHERE conversation_id=$1 ORDER BY kind",
      [conversationId],
    );
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) => seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await sql(w, "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name IN ('knowledge_v1','knowledge_index_v1','ai_agent_v1','settings_v1','ai_providers_v1')", [w]);
      await sql(w, "DELETE FROM calendar_assignments");
    }
    await sql("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')");
    await sql("a", "INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_ai,for_help_center) VALUES('a','refunds','article','owner','public',true,false)");
    await sql(
      "a",
      "INSERT INTO knowledge_locales(workspace_id,record_id,locale,status,draft_title,published_title,published_text,published_revision,published_at) VALUES('a','refunds','en','published','Refunds','Refunds','Refunds take five working days to reach the card you paid with.',1,now())",
    );
    await scheduleIndex(db.connect, "a");
    await drain("knowledge.index");

    // The page: workspace managers only; every provider, none connected; Relay's AI by default.
    assert.equal((await agent("ai-providers", undefined, "agent-1-a")).status, 403);
    const empty = await agent("ai-providers");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.providers.map((p: { id: string }) => p.id), ["anthropic", "openai", "gemini", "deepseek", "custom"]);
    assert.ok(empty.body.providers.every((p: { connection: unknown }) => p.connection === null));
    assert.deepEqual([empty.body.primary, empty.body.fallback, empty.body.relay.model], [null, null, "stand-in"]);
    assert.equal(await tenant(db.connect, "a", (q) => keySourceOf(q, "a")), "relay");

    // Saving: a key is needed the first time; a model name as the provider writes it; a custom endpoint at a public https address.
    assert.match((await agent("ai-providers", { action: "save", provider: "openai", model: "gpt-6-luna" })).body.error.message, /Paste your OpenAI API key/);
    assert.match((await agent("ai-providers", { action: "save", provider: "openai", key: "sk-test", model: "gpt 6" })).body.error.message, /API key on one line/);
    assert.match((await agent("ai-providers", { action: "save", provider: "openai", key: "sk-test-openai-secret-1234", model: "gpt 6" })).body.error.message, /model's name/);
    assert.match(
      (await agent("ai-providers", { action: "save", provider: "custom", key: "gw-key-secret-0000", model: "m", baseUrl: "http://gateway.example/v1" })).body.error.message,
      /https base URL/,
    );
    assert.equal((await agent("ai-providers", { action: "save", provider: "openai", key: "sk-test-openai-secret-1234", model: "gpt-6-luna" }, "agent-1-a")).status, 403);
    const saved = await agent("ai-providers", { action: "save", provider: "openai", key: "sk-test-openai-secret-1234", model: "gpt-6-luna" });
    assert.equal(saved.status, 200);
    const openaiCard = saved.body.providers.find((p: { id: string }) => p.id === "openai");
    assert.deepEqual([openaiCard.connection.keyHint, openaiCard.connection.model, openaiCard.connection.role, openaiCard.connection.test], ["1234", "gpt-6-luna", null, null]);
    // The key is never returned, never stored readable, and never in the audit log.
    assert.ok(!JSON.stringify(saved.body).includes("sk-test-openai-secret"));
    assert.ok(!JSON.stringify(await sql("a", "SELECT * FROM ai_providers")).includes("sk-test-openai-secret"));
    const audited = await sql("a", "SELECT action,details FROM audit_events WHERE action LIKE 'ai_provider.%'");
    assert.deepEqual(audited.map((r) => r.action), ["ai_provider.created"]);
    assert.ok(!JSON.stringify(audited).includes("sk-test-openai-secret"));

    // Save and test: one fixed question and passage (no customer data), the result kept on the connection.
    const tested = await agent("ai-providers", { action: "save", provider: "anthropic", key: "sk-ant-test-secret-abcd", model: "claude-haiku-5-5", test: true });
    assert.ok(tested.body.jobId);
    await drain("ai.provider.test");
    const afterTest = (await agent("ai-providers")).body.providers.find((p: { id: string }) => p.id === "anthropic").connection.test;
    assert.equal(afterTest.ok, true);
    assert.match(afterTest.detail, /^Answered a test question with claude-haiku-5-5 in \d+\.\d s\.$/);
    const testSent = JSON.stringify(sent.at(-1)!.body);
    assert.match(testSent, /Support hours/);
    assert.doesNotMatch(testSent, /Refunds|customer-/);
    assert.equal(sent.at(-1)!.headers.get("authorization"), "Bearer sk-ant-test-secret-abcd");
    // A refused key is told plainly.
    mode.openai = "401";
    await agent("ai-providers", { action: "test", provider: "openai" });
    await drain("ai.provider.test");
    const failedTest = (await agent("ai-providers")).body.providers.find((p: { id: string }) => p.id === "openai").connection.test;
    assert.deepEqual([failedTest.ok, failedTest.detail], [false, "The provider refused the key (401). Check the key, and that it may use this model."]);
    mode.openai = "ok";
    // Saved again unchanged (the key kept), the result stands; a changed model hasn't been tested.
    await agent("ai-providers", { action: "save", provider: "openai", model: "gpt-6-luna" });
    assert.equal((await agent("ai-providers")).body.providers.find((p: { id: string }) => p.id === "openai").connection.test.ok, false);
    await agent("ai-providers", { action: "save", provider: "openai", model: "gpt-5.4-mini" });
    assert.equal((await agent("ai-providers")).body.providers.find((p: { id: string }) => p.id === "openai").connection.test, null);
    await agent("ai-providers", { action: "save", provider: "openai", model: "gpt-6-luna" });

    // Choosing: a fallback needs a primary, a different one, and only connected providers.
    assert.match((await agent("ai-providers", { action: "roles", primary: null, fallback: "openai" })).body.error.message, /primary provider before a fallback/);
    assert.match((await agent("ai-providers", { action: "roles", primary: "openai", fallback: "openai" })).body.error.message, /different provider/);
    assert.match((await agent("ai-providers", { action: "roles", primary: "gemini", fallback: null })).body.error.message, /Connect Gemini first/);
    const chosen = await agent("ai-providers", { action: "roles", primary: "openai", fallback: "anthropic" });
    assert.deepEqual([chosen.body.primary, chosen.body.fallback], ["openai", "anthropic"]);
    assert.equal(await tenant(db.connect, "a", (q) => keySourceOf(q, "a")), "workspace");

    // Zoe answers with the workspace's primary for both classifying and answering; Relay's AI is never asked.
    const first = await start("How long do refunds take?");
    const reply = (await sql<{ id: string; body: string }>("a", "SELECT id,body FROM conversation_parts WHERE conversation_id=$1 AND kind='ai_reply'", [first.id]))[0];
    assert.equal(reply.body, "Refunds take five working days.");
    assert.equal(relayCalls, 0);
    assert.deepEqual(await calls(first.id), [
      { kind: "answer", provider: "openai", model: "gpt-6-luna-2026-10-01", key_source: "workspace", failover: null },
      { kind: "classify", provider: "openai", model: "gpt-6-luna-2026-10-01", key_source: "workspace", failover: null },
    ]);
    assert.deepEqual(await sql("a", "SELECT model,key_source FROM ai_answers WHERE conversation_id=$1", [first.id]), [{ model: "gpt-6-luna-2026-10-01", key_source: "workspace" }]);

    // The primary fails: the fallback answers, and the record says which failed and why.
    mode.openai = "500";
    const second = await start("Do refunds take long?");
    assert.equal((await sql("a", "SELECT 1 FROM conversation_parts WHERE conversation_id=$1 AND kind='ai_reply'", [second.id])).length, 1);
    assert.deepEqual(await calls(second.id), [
      { kind: "answer", provider: "anthropic", model: "claude-haiku-5-5", key_source: "workspace", failover: "openai gpt-6-luna: The answering model returned 500." },
      { kind: "classify", provider: "anthropic", model: "claude-haiku-5-5", key_source: "workspace", failover: "openai gpt-6-luna: The classifier returned 500." },
    ]);
    assert.equal(relayCalls, 0);
    const week = (await agent("ai-providers")).body.providers;
    assert.equal(week.find((p: { id: string }) => p.id === "openai").connection.lastWeek.failedOver, 2);
    assert.equal(week.find((p: { id: string }) => p.id === "anthropic").connection.lastWeek.served, 2);
    mode.openai = "ok";

    // A resolution on the workspace's key is its own meter (and price slot), not Relay's.
    assert.ok(METER_IDS.includes("ai_resolutions_own_key") && "ai_resolutions_own_key" in UNIT_PRICES);
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "contact", identityId: first.identityId, brandId: "default" }, crypto.randomUUID(), { action: "ai_helped", conversationId: first.id, partId: reply.id }));
    assert.deepEqual(await sql("a", "SELECT kind,key_source FROM ai_resolutions WHERE conversation_id=$1", [first.id]), [{ kind: "resolution", key_source: "workspace" }]);
    const totals = await tenant(db.connect, "a", async (q) => {
      const period = await periodFor(q, "a", "current", new Date());
      return [await meterTotal(q, "a", "ai_resolutions", period), await meterTotal(q, "a", "ai_resolutions_own_key", period)];
    });
    assert.deepEqual(totals, [0, 1]);

    // Limits: Zoe asks the own-key meter while she answers with the workspace's key (Relay's meter's limit doesn't pause her).
    await tenant(db.connect, "a", (q) => changeLimits(q, "a", "owner-a", { limits: { ai_resolutions: 1 } }));
    await sql("a", "INSERT INTO ai_resolutions(workspace_id,id,kind,conversation_id,agent_id,rule,window_hours,recorded_at) VALUES('a','relay-r','resolution',$1,'default','confirmed',24,now())", [second.id]);
    const third = await start("Refunds again?");
    assert.equal((await sql("a", "SELECT 1 FROM conversation_parts WHERE conversation_id=$1 AND kind='ai_reply'", [third.id])).length, 1, "Relay's limit doesn't apply to her own-key answers");
    await tenant(db.connect, "a", (q) => changeLimits(q, "a", "owner-a", { limits: { ai_resolutions: null, ai_resolutions_own_key: 1 } }));
    const fourth = await start("And refunds to a card?");
    const note = await sql<{ body: string }>("a", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND kind='internal_note'", [fourth.id]);
    assert.deepEqual(note.map((x) => x.body), ["Zoe didn't answer: This period's limit for AI resolutions on your own AI key (1) is reached. A teammate needs to reply."]);
    await tenant(db.connect, "a", (q) => changeLimits(q, "a", "owner-a", { limits: { ai_resolutions_own_key: null } }));

    // A key that can't be read (the connector key changed) fails like a provider that's down: the fallback answers, never Relay's key.
    await sql("a", "UPDATE ai_providers SET key_sealed=$1 WHERE provider='openai'", [await seal("x".repeat(40), "a", "ai-provider", "openai", "sk-other")]);
    let served: Served | null = null;
    const models = await withWorkspaceModels(db.connect, ai, "a");
    await models.model.answer(TEST_REQUEST, (s) => (served = s));
    assert.equal((served as Served | null)?.provider, "anthropic");
    assert.match((served as Served | null)?.failover ?? "", /^openai unavailable: OpenAI's key can't be read\. Enter it again on Settings › AI providers\.$/);
    assert.equal(relayCalls, 0);

    // Another workspace sees none of this, and answers with Relay's AI.
    const other = await agent("ai-providers", undefined, "owner-b", "b");
    assert.ok(other.body.providers.every((p: { connection: unknown }) => p.connection === null));
    assert.equal(await withWorkspaceModels(db.connect, ai, "b"), ai);
    assert.equal((await agent("ai-providers", { action: "remove", provider: "openai" }, "owner-b", "b")).status, 400);

    // Removing the primary clears the fallback: Zoe goes back to Relay's AI.
    const removed = await agent("ai-providers", { action: "remove", provider: "openai" });
    assert.deepEqual([removed.body.primary, removed.body.fallback], [null, null]);
    assert.equal(await withWorkspaceModels(db.connect, ai, "a"), ai);
    assert.deepEqual(
      (await sql("a", "SELECT action FROM audit_events WHERE action LIKE 'ai_provider.%'")).map((r) => r.action).filter((a, i, all) => all.indexOf(a) === i).sort(),
      ["ai_provider.changed", "ai_provider.created", "ai_provider.deleted"],
    );

    // Behind its flag: off, the page is gone and a primary is ignored.
    await agent("ai-providers", { action: "roles", primary: "anthropic", fallback: null });
    await sql("a", "UPDATE workspace_features SET enabled=false WHERE name='ai_providers_v1'");
    assert.equal((await agent("ai-providers")).status, 404);
    assert.equal(await withWorkspaceModels(db.connect, ai, "a"), ai);
    await sql("a", "UPDATE workspace_features SET enabled=true WHERE name='ai_providers_v1'");
    assert.notEqual(await withWorkspaceModels(db.connect, ai, "a"), ai);

    // The rollback: no primary or fallback anywhere and the flag off, so every workspace is on Relay's AI again; connections stay.
    await db.pg.exec(await readFile("db/rollback/0097_ai_providers.sql", "utf8"));
    assert.deepEqual(await sql("a", "SELECT provider,role FROM ai_providers"), [{ provider: "anthropic", role: null }]);
    assert.equal(await withWorkspaceModels(db.connect, ai, "a"), ai);
    assert.equal(await tenant(db.connect, "a", (q) => keySourceOf(q, "a")), "relay");
  } finally {
    await db.close();
  }
});
