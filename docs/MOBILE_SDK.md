# Relay mobile SDK interface

Status: interface specification only. No iOS or Android SDK, push sender or native UI is implemented by this phase.

## Scope and shared contract

Both SDKs mirror the web messenger: Home, Messages and Help; a selected conversation, article or survey; identity changes and logout; server-provided unread counts; and push handling. Workspace and brand are explicit configuration, never inferred from an email address. Initialize once per app process. Switching workspace or brand creates a new isolated instance and clears the previous presentation/session.

Configuration contains `workspaceId`, `brandId`, trusted HTTPS API origin, optional BCP-47 locale, theme (`system`, `light`, `dark`) and an asynchronous identity-token provider. It never contains the customer's workspace signing secret. Tokens are obtained from the customer's authenticated backend; the SDK cannot mint its own verified user identity.

All SDK mutations use stable client idempotency keys across network retries. Session epochs prevent an old identity request or push callback from updating a newer user's UI. Data, cached transcripts, draft keys, unread snapshots, upload work and push bindings are scoped by workspace, brand and identity. Device-local state is not the conversation source of truth.

## Common value types

| Type | Fields / semantics |
| --- | --- |
| `RelayConfiguration` | Workspace ID, brand ID, API origin, optional locale, theme. |
| `RelaySpace` | `home`, `messages`, `help`. |
| `RelayUser` | `userId`, `email`, optional display name. Display name is presentation data, not authentication. |
| `RelayIdentityProof` | `jwt(String)` or an explicitly enabled versioned HMAC envelope containing key ID, expiry and signature. |
| `IdentityProofProvider` | Async callback obtaining a fresh proof from the host application's backend. Receives user and refresh reason. Must not log tokens. |
| `RelayContext` | Application route/screen, optional sanitized HTTPS page URL, locale. Context is untrusted targeting input, never authorization. |
| `UnreadSnapshot` | Server-computed count, server version, workspace ID, brand ID, session epoch and freshness (`current`, `stale`, `unknown`). Never derive a count from locally cached messages. |
| `RelayPushEnvelope` | Version, notification ID, workspace/brand, opaque recipient binding, permitted destination and optional server unread snapshot/version. No signing secrets or identity JWT. |
| `PushDisposition` | `ignored`, `handled`, `deferredUntilReady`; includes a validated destination when appropriate. |
| `RelayCancellation` | Cancels an observer; repeated cancellation is harmless. |
| `LogoutResult` | Whether remote revocation completed or remains pending; local account data has already been cleared in either case. |

## iOS interface — proposed Swift surface

These are public signatures, not an SDK implementation. Named value types are specified above.

```swift
@MainActor
public protocol RelayMessenger {
    func configure(_ configuration: RelayConfiguration) async throws
    func setUser(_ user: RelayUser,
                 proofProvider: @escaping IdentityProofProvider) async throws
    func setAnonymousUser() async throws
    func updateContext(_ context: RelayContext) async throws
    func logout() async -> LogoutResult

    func present(from presenter: UIViewController) async throws
    func present(space: RelaySpace, from presenter: UIViewController) async throws
    func presentConversation(id: String, from presenter: UIViewController) async throws
    func presentArticle(id: String, from presenter: UIViewController) async throws
    func presentSurvey(id: String, from presenter: UIViewController) async throws
    func dismiss() async

    func observeUnreadCount(
        _ listener: @escaping (UnreadSnapshot) -> Void
    ) -> RelayCancellation

    func registerPushToken(_ token: Data,
                           environment: APNsEnvironment) async throws
    func unregisterPushToken() async throws
    func handlePush(_ payload: [AnyHashable: Any],
                    interaction: PushInteraction) async -> PushDisposition
}
```

Presentation and observers run on the main actor. Networking and decoding must not block it. The host passes the active scene's presenter; the SDK does not guess a global key window. Do not retain a presentation controller after dismissal. Respect Dynamic Type, VoiceOver order, reduced motion, safe areas and right-to-left layout.

The host app owns notification permission requests, APNs registration and its notification-center delegate. It forwards token changes and notification receipt/taps to Relay, preserving other SDK integrations. APNs environment is explicitly sandbox or production. Receipt alone must not present UI. [Apple APNs registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns).

## Android interface — proposed Kotlin surface

```kotlin
interface RelayMessenger {
    suspend fun configure(configuration: RelayConfiguration)
    suspend fun setUser(user: RelayUser, proofProvider: IdentityProofProvider)
    suspend fun setAnonymousUser()
    suspend fun updateContext(context: RelayContext)
    suspend fun logout(): LogoutResult

    suspend fun present(activity: FragmentActivity)
    suspend fun presentSpace(space: RelaySpace, activity: FragmentActivity)
    suspend fun presentConversation(id: String, activity: FragmentActivity)
    suspend fun presentArticle(id: String, activity: FragmentActivity)
    suspend fun presentSurvey(id: String, activity: FragmentActivity)
    suspend fun dismiss()

    val unreadCounts: StateFlow<UnreadSnapshot>
    fun observeUnreadCount(listener: (UnreadSnapshot) -> Unit): RelayCancellation

    suspend fun registerPushToken(token: String)
    suspend fun unregisterPushToken()
    suspend fun handlePush(
        payload: Map<String, String>, interaction: PushInteraction
    ): PushDisposition
}
```

Public suspend operations support coroutine cancellation. Presentation dispatches to the main thread and requires a resumed Activity; otherwise return `PRESENTATION_UNAVAILABLE`. Do not retain Activities in singleton state. Observers are lifecycle-cancellable and deliver on the main thread. Respect system font scaling, TalkBack, RTL, reduced animation preferences and system insets.

The host owns `FirebaseMessagingService`, token refresh, runtime notification permission and tap intents. Forward Relay data to `handlePush`; do not replace the app's messaging service. Background notification messages and foreground/data messages take different platform paths. Long-running recovery belongs in scheduled background work, not the short message-receipt callback. [FCM receive handling](https://firebase.google.com/docs/cloud-messaging/android/receive-messages).

## Identity lifecycle

1. `configure` loads public brand capabilities without presenting UI or requesting notification permission.
2. Anonymous boot uses a high-entropy device token stored securely on the device. No advertising identifier is required.
3. `setUser` obtains a proof from the host backend, exchanges it for a brand-scoped Relay session, and switches identity atomically. The server performs any authorized non-destructive visitor merge.
4. Verified identity is established only after server verification. A token supplied by the app is not trusted because it decodes successfully.
5. JWT validation uses a fixed permitted algorithm, key ID, workspace, issuer, audience, subject/email match and expiry. Two live workspace keys support rotation. Invalid signed proofs fail even when enforcement is disabled; they never downgrade to anonymous/HMAC automatically. [JWT best practices](https://www.rfc-editor.org/rfc/rfc8725).
6. An unsigned legacy client receives `IDENTITY_SIGNATURE_REQUIRED` when enforcement is on. The SDK exposes this to the integrator rather than looping retries. An unverified profile when enforcement is off must not unlock an existing user's history.
7. On expiry, call the proof provider once per session refresh; coalesce concurrent refreshes. If it fails, stop authenticated work, preserve only identity-scoped drafts and show a recoverable sign-in state. Do not replay user A's pending messages after switching to user B.
8. `logout` immediately dismisses/clears personal UI, cancels subscriptions/uploads, clears cached transcripts and drafts, resets the unread snapshot, rotates the anonymous device token and invalidates the local session epoch. Revoke the server session and recipient push binding. Offline remote revocation remains pending and is reported; do not claim that an offline device has already revoked a server token.

The HMAC fallback must use an agreed wire format. The proposed expiry-bound envelope is documented in `MESSENGER.md`. A permanent HMAC of only a user ID cannot assert an email or expiry; support for an existing scheme of that kind requires a separate migration decision, not silent acceptance under JWT enforcement.

## Presentation and parity

- `present()` opens the configured default space; other methods navigate directly to their named destination after server authorization.
- Calling presentation twice focuses/navigates the existing messenger rather than opening two copies.
- Opening an article can start a conversation carrying an immutable article ID/version context. Help is owned by the help-center phase; ticket history by phase 5; surveys by the survey/outbound phase. If an integration is unavailable, return `FEATURE_UNAVAILABLE` rather than a blank success screen.
- Named teammate, automation and AI labels come from server author types. Human handover appears as a durable in-thread marker.
- Office-hours status, expected response time, queue position and unread totals are server-owned. Omit unavailable estimates rather than generating them on-device.
- Uploads use the same signed storage/quarantine/scanning flow as web. A successful byte upload is not equivalent to a clean, available attachment.
- Reconnect uses durable cursors and part-ID deduplication. A merge can require a timeline snapshot/revision reset. Typing/presence are expiring signals, not offline history.
- Locale fallback: requested locale, compatible script/language fallback, brand locale, workspace locale, English. Server/user content is not machine-translated without a separate feature. Use platform locale-aware formatting and bidi isolation around identifiers.

## Unread callback guarantees

Observers first receive the latest snapshot, including an explicit unknown state before server synchronization. Later snapshots include monotonically increasing server versions within a session epoch. Discard older versions; reset on identity change. Background suspension makes data stale, not zero. Reconnect fetches a server snapshot before resuming deltas. Observers must not require polling.

## Push handling

`PushInteraction` distinguishes background receipt, foreground receipt and an explicit notification tap. Validate the envelope version, tenant/brand, recipient binding and destination. Deduplicate by notification ID, but separately remember whether a tap destination has been consumed: receiving a notification must not suppress its later tap.

Push is a notification hint, not an authoritative conversation part. Recover the timeline and counts from the authenticated service. A delayed push for a logged-out or different user is ignored without rendering personal content. A tap before configuration/login returns `deferredUntilReady` with an opaque destination; never authenticate someone from a push payload. Only a validated tap presents UI. Preserve a bounded pending destination across process recreation; reauthorize before opening it.

Token rotation updates the existing registration idempotently. Logout unbinds this installation from the old recipient. App uninstall/reinstall is a new installation; failed deliveries disable obsolete registrations server-side. The future push backend owns APNs/FCM credentials and delivery retries.

## Stable errors

`NOT_CONFIGURED`, `FEATURE_DISABLED`, `FEATURE_UNAVAILABLE`, `IDENTITY_SIGNATURE_REQUIRED`, `IDENTITY_INVALID`, `SESSION_EXPIRED`, `FORBIDDEN`, `NOT_FOUND`, `NETWORK_UNAVAILABLE`, `RATE_LIMITED`, `UPLOAD_REJECTED`, `PRESENTATION_UNAVAILABLE`, `CANCELLED`, `SERVER_UNAVAILABLE`.

Errors contain a code, safe localized message, retryability and optional request ID. Never include raw JWTs, workspace signing keys, notification tokens or another identity's identifiers in logs/errors.

## Acceptance for the future SDK phase

- Same behavioral contract exercised on both platforms.
- Forged/expired/wrong-workspace proof rejection and two-key rotation.
- User A → logout → user B while requests, uploads and push callbacks are in flight; no cross-account leakage.
- Cold-start push tap, foreground push, background push, duplicate delivery and delayed old-account push.
- Offline logout with explicit pending remote revocation; no automatic replay under the next identity.
- Cursor reconnect, conversation merge and server unread-version reconciliation.
- VoiceOver/TalkBack, large text, RTL, reduced motion, keyboard/switch access and lifecycle recreation.
- Unavailable article/survey/ticket providers return explicit errors.

Platform minimum OS versions and package distribution are decisions for the SDK implementation phase. This document does not silently select them or create native projects.
