# Python Relay API client, generated from lib/api-spec.ts by `npm run api:doc` (API version 2026-10-20). Don't edit by hand.
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

VERSION = "2026-10-20"


def _e(v):
    return urllib.parse.quote(str(v), safe="")


def verify_webhook(secret, raw_body, signature_header, tolerance=300, now=None):
    """Verifies a webhook delivery's Relay-Signature against the raw body (bytes); returns its event, or raises ValueError."""
    import hashlib
    import hmac

    items = [p.split("=", 1) for p in (signature_header or "").split(",") if "=" in p]
    t = next((int(v) for k, v in items if k == "t" and v.isdigit()), 0)
    if not t or abs((now if now is not None else time.time()) - t) > tolerance:
        raise ValueError("Relay webhook: the signature's time is missing or too old.")
    body = raw_body if isinstance(raw_body, bytes) else raw_body.encode()
    want = hmac.new(secret.encode(), str(t).encode() + b"." + body, hashlib.sha256).hexdigest()
    if not any(k == "v1" and hmac.compare_digest(v, want) for k, v in items):
        raise ValueError("Relay webhook: the signature doesn't match.")
    return json.loads(body.decode())


class RelayError(Exception):
    """An error from the API: its HTTP status, stable code, message, the field at fault, and request id."""

    def __init__(self, status, body):
        first = ((body or {}).get("errors") or [{}])[0]
        super().__init__(first.get("message") or "Relay API error %s" % status)
        self.status = status
        self.code = first.get("code", "unknown")
        self.field = first.get("field")
        self.request_id = (body or {}).get("request_id")
        self.errors = (body or {}).get("errors") or []


class Relay:
    def __init__(self, token, base_url, version=VERSION, max_retries=3, timeout=30):
        if not token:
            raise ValueError("Relay: a token is required.")
        if not base_url:
            raise ValueError("Relay: base_url is required (https://api.<your domain>/rest).")
        self.token = token
        self.base_url = base_url.rstrip("/")
        self.version = version
        self.max_retries = max_retries
        self.timeout = timeout

    def request(self, method, path, query=None, body=None, idempotency_key=None):
        """One call: the token, the version, an idempotency key on POST, and a wait on 429."""
        url = self.base_url + path
        params = {k: v for k, v in (query or {}).items() if v is not None}
        if params:
            url += "?" + urllib.parse.urlencode({k: (str(v).lower() if isinstance(v, bool) else v) for k, v in params.items()})
        headers = {"authorization": "Bearer " + self.token, "relay-version": self.version, "accept": "application/json"}
        data = None
        if body is not None:
            headers["content-type"] = "application/json"
            data = json.dumps(body).encode()
        if method == "POST":
            headers["idempotency-key"] = idempotency_key or str(uuid.uuid4())
        attempt = 0
        while True:
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as res:
                    return json.loads(res.read().decode() or "null")
            except urllib.error.HTTPError as e:
                payload = None
                try:
                    payload = json.loads(e.read().decode())
                except Exception:
                    pass
                if e.code == 429 and attempt < self.max_retries:
                    attempt += 1
                    time.sleep(max(0, float(e.headers.get("retry-after") or 1)))
                    continue
                raise RelayError(e.code, payload) from None

    def get_me(self, *, idempotency_key=None):
        """Who the token is. The workspace, the teammate the token acts as, its scopes and its version."""
        return self.request("GET", "/me", query=None, idempotency_key=idempotency_key)

    def list_conversations(self, *, status=None, assignee_id=None, team_id=None, per_page=None, starting_after=None, idempotency_key=None):
        """List conversations. Customer-facing conversations, most recently updated first."""
        return self.request("GET", "/conversations", query={"status": status, "assignee_id": assignee_id, "team_id": team_id, "per_page": per_page, "starting_after": starting_after}, idempotency_key=idempotency_key)

    def iter_list_conversations(self, *, status=None, assignee_id=None, team_id=None, per_page=None):
        """Every page of list_conversations, item by item."""
        after = None
        while True:
            page = self.list_conversations(status=status, assignee_id=assignee_id, team_id=team_id, per_page=per_page, starting_after=after)
            yield from page["data"]
            after = page["pages"]["next"]
            if not after:
                return

    def create_conversation(self, body, *, idempotency_key=None):
        """Start a conversation for a contact. A new conversation, started by the contact with their message (as if they'd written in). Send `Idempotency-Key` to make retries safe."""
        return self.request("POST", "/conversations", query=None, body=body, idempotency_key=idempotency_key)

    def get_conversation(self, id, *, idempotency_key=None):
        """Retrieve a conversation. One conversation. Its messages and notes are its parts."""
        return self.request("GET", f"/conversations/{_e(id)}", query=None, idempotency_key=idempotency_key)

    def list_conversation_parts(self, id, *, per_page=None, starting_after=None, idempotency_key=None):
        """List a conversation's parts. Its messages, replies, notes and events, oldest first. Internal notes are marked `internal`; they're never shown to the customer."""
        return self.request("GET", f"/conversations/{_e(id)}/parts", query={"per_page": per_page, "starting_after": starting_after}, idempotency_key=idempotency_key)

    def iter_list_conversation_parts(self, id, *, per_page=None):
        """Every page of list_conversation_parts, item by item."""
        after = None
        while True:
            page = self.list_conversation_parts(id, per_page=per_page, starting_after=after)
            yield from page["data"]
            after = page["pages"]["next"]
            if not after:
                return

    def reply_to_conversation(self, id, body, *, idempotency_key=None):
        """Reply. A reply to the customer, as the token's teammate. Send `Idempotency-Key` to make retries safe."""
        return self.request("POST", f"/conversations/{_e(id)}/reply", query=None, body=body, idempotency_key=idempotency_key)

    def add_conversation_note(self, id, body, *, idempotency_key=None):
        """Add an internal note. A note only teammates see."""
        return self.request("POST", f"/conversations/{_e(id)}/notes", query=None, body=body, idempotency_key=idempotency_key)

    def assign_conversation(self, id, body, *, idempotency_key=None):
        """Assign. Assign to a teammate and/or a team; `null` clears either."""
        return self.request("POST", f"/conversations/{_e(id)}/assign", query=None, body=body, idempotency_key=idempotency_key)

    def snooze_conversation(self, id, body, *, idempotency_key=None):
        """Snooze. Snooze until a time (with its offset)."""
        return self.request("POST", f"/conversations/{_e(id)}/snooze", query=None, body=body, idempotency_key=idempotency_key)

    def close_conversation(self, id, *, idempotency_key=None):
        """Close. Close the conversation."""
        return self.request("POST", f"/conversations/{_e(id)}/close", query=None, idempotency_key=idempotency_key)

    def open_conversation(self, id, *, idempotency_key=None):
        """Reopen. Reopen a closed or snoozed conversation."""
        return self.request("POST", f"/conversations/{_e(id)}/open", query=None, idempotency_key=idempotency_key)

    def tag_conversation(self, id, body, *, idempotency_key=None):
        """Tag. Add a tag to the conversation."""
        return self.request("POST", f"/conversations/{_e(id)}/tags", query=None, body=body, idempotency_key=idempotency_key)

    def untag_conversation(self, id, tag_id, *, idempotency_key=None):
        """Remove a tag. Remove a tag from the conversation."""
        return self.request("DELETE", f"/conversations/{_e(id)}/tags/{_e(tag_id)}", query=None, idempotency_key=idempotency_key)

    def list_contacts(self, *, email=None, external_id=None, per_page=None, starting_after=None, idempotency_key=None):
        """List contacts. Contacts (not merged away), by id."""
        return self.request("GET", "/contacts", query={"email": email, "external_id": external_id, "per_page": per_page, "starting_after": starting_after}, idempotency_key=idempotency_key)

    def iter_list_contacts(self, *, email=None, external_id=None, per_page=None):
        """Every page of list_contacts, item by item."""
        after = None
        while True:
            page = self.list_contacts(email=email, external_id=external_id, per_page=per_page, starting_after=after)
            yield from page["data"]
            after = page["pages"]["next"]
            if not after:
                return

    def create_contact(self, body, *, idempotency_key=None):
        """Create a contact. A user (with your `external_id` for them) or a lead (with an email). Creating one that exists (the same `external_id`) returns it, so retries are safe."""
        return self.request("POST", "/contacts", query=None, body=body, idempotency_key=idempotency_key)

    def get_contact(self, id, *, idempotency_key=None):
        """Retrieve a contact. One contact. A merged contact's id leads to the contact it joined."""
        return self.request("GET", f"/contacts/{_e(id)}", query=None, idempotency_key=idempotency_key)

    def update_contact(self, id, body, *, idempotency_key=None):
        """Update a contact. Change the name, or set custom attributes (`null` removes one). Others are left as they are."""
        return self.request("PATCH", f"/contacts/{_e(id)}", query=None, body=body, idempotency_key=idempotency_key)

    def list_tags(self, *, idempotency_key=None):
        """List tags. The workspace's tags (archived ones are left out)."""
        return self.request("GET", "/tags", query=None, idempotency_key=idempotency_key)

    def create_tag(self, body, *, idempotency_key=None):
        """Create a tag. A new tag. A name that's taken returns the existing tag."""
        return self.request("POST", "/tags", query=None, body=body, idempotency_key=idempotency_key)

    def list_teammates(self, *, idempotency_key=None):
        """List teammates. Everyone in the workspace."""
        return self.request("GET", "/teammates", query=None, idempotency_key=idempotency_key)

    def get_teammate(self, id, *, idempotency_key=None):
        """Retrieve a teammate. One teammate."""
        return self.request("GET", f"/teammates/{_e(id)}", query=None, idempotency_key=idempotency_key)

    def list_teams(self, *, idempotency_key=None):
        """List teams. The workspace's teams and their members."""
        return self.request("GET", "/teams", query=None, idempotency_key=idempotency_key)

    def get_team(self, id, *, idempotency_key=None):
        """Retrieve a team. One team and its members."""
        return self.request("GET", f"/teams/{_e(id)}", query=None, idempotency_key=idempotency_key)

    def search_conversations(self, body, *, idempotency_key=None):
        """Search conversations. Conversations matching a query, sorted and cursor-paged. Fields: id, status, channel, brand_id, assignee_id, team_id, contact_id, tag_id, priority, created_at, updated_at, waiting_since."""
        return self.request("POST", "/conversations/search", query=None, body=body, idempotency_key=idempotency_key)

    def iter_search_conversations(self, body):
        """Every page of search_conversations, item by item."""
        after = None
        while True:
            page = self.search_conversations(dict(body, **({'starting_after': after} if after else {})))
            yield from page["data"]
            after = page["pages"]["next"]
            if not after:
                return

    def search_contacts(self, body, *, idempotency_key=None):
        """Search contacts. Contacts matching a query, sorted and cursor-paged. Fields: id, role, name, email, external_id, first_seen_at, last_seen_at, signed_up_at, and custom_attributes.<name>."""
        return self.request("POST", "/contacts/search", query=None, body=body, idempotency_key=idempotency_key)

    def iter_search_contacts(self, body):
        """Every page of search_contacts, item by item."""
        after = None
        while True:
            page = self.search_contacts(dict(body, **({'starting_after': after} if after else {})))
            yield from page["data"]
            after = page["pages"]["next"]
            if not after:
                return

    def list_contact_events(self, id, *, per_page=None, starting_after=None, idempotency_key=None):
        """List a contact's events. What they did, newest first (from your server, or the messenger while they're signed in)."""
        return self.request("GET", f"/contacts/{_e(id)}/events", query={"per_page": per_page, "starting_after": starting_after}, idempotency_key=idempotency_key)

    def iter_list_contact_events(self, id, *, per_page=None):
        """Every page of list_contact_events, item by item."""
        after = None
        while True:
            page = self.list_contact_events(id, per_page=per_page, starting_after=after)
            yield from page["data"]
            after = page["pages"]["next"]
            if not after:
                return

    def create_contact_event(self, id, body, *, idempotency_key=None):
        """Record an event. Something the contact did. `id` is yours: an event with an id that's been seen is ignored, so retries are safe."""
        return self.request("POST", f"/contacts/{_e(id)}/events", query=None, body=body, idempotency_key=idempotency_key)

    def list_tickets(self, *, ticket_type_id=None, state=None, per_page=None, starting_after=None, idempotency_key=None):
        """List tickets. Tickets, newest first, by type or state."""
        return self.request("GET", "/tickets", query={"ticket_type_id": ticket_type_id, "state": state, "per_page": per_page, "starting_after": starting_after}, idempotency_key=idempotency_key)

    def iter_list_tickets(self, *, ticket_type_id=None, state=None, per_page=None):
        """Every page of list_tickets, item by item."""
        after = None
        while True:
            page = self.list_tickets(ticket_type_id=ticket_type_id, state=state, per_page=per_page, starting_after=after)
            yield from page["data"]
            after = page["pages"]["next"]
            if not after:
                return

    def create_ticket(self, body, *, idempotency_key=None):
        """Make a conversation a ticket. Turn a conversation into a ticket of a type (in its first state, or the one given)."""
        return self.request("POST", "/tickets", query=None, body=body, idempotency_key=idempotency_key)

    def get_ticket(self, id, *, idempotency_key=None):
        """Retrieve a ticket. One ticket (its id is its conversation's)."""
        return self.request("GET", f"/tickets/{_e(id)}", query=None, idempotency_key=idempotency_key)

    def set_ticket_state(self, id, body, *, idempotency_key=None):
        """Change a ticket's state. Move a ticket to another of its type's states."""
        return self.request("POST", f"/tickets/{_e(id)}/state", query=None, body=body, idempotency_key=idempotency_key)

    def list_ticket_types(self, *, idempotency_key=None):
        """List ticket types. The workspace's ticket types and their states (archived ones left out)."""
        return self.request("GET", "/ticket_types", query=None, idempotency_key=idempotency_key)

    def get_ticket_type(self, id, *, idempotency_key=None):
        """Retrieve a ticket type. One ticket type and its states."""
        return self.request("GET", f"/ticket_types/{_e(id)}", query=None, idempotency_key=idempotency_key)

    def list_help_centers(self, *, idempotency_key=None):
        """List help centers. Each brand's help center and its collections."""
        return self.request("GET", "/help_centers", query=None, idempotency_key=idempotency_key)

    def get_help_center(self, id, *, idempotency_key=None):
        """Retrieve a help center. One help center and its collections."""
        return self.request("GET", f"/help_centers/{_e(id)}", query=None, idempotency_key=idempotency_key)

    def list_articles(self, *, state=None, per_page=None, starting_after=None, idempotency_key=None):
        """List articles. Articles, most recently updated first."""
        return self.request("GET", "/articles", query={"state": state, "per_page": per_page, "starting_after": starting_after}, idempotency_key=idempotency_key)

    def iter_list_articles(self, *, state=None, per_page=None):
        """Every page of list_articles, item by item."""
        after = None
        while True:
            page = self.list_articles(state=state, per_page=per_page, starting_after=after)
            yield from page["data"]
            after = page["pages"]["next"]
            if not after:
                return

    def create_article(self, body, *, idempotency_key=None):
        """Create an article. A new article, as a draft. Paragraphs are separated by a blank line. Publish it to put it live."""
        return self.request("POST", "/articles", query=None, body=body, idempotency_key=idempotency_key)

    def get_article(self, id, *, idempotency_key=None):
        """Retrieve an article. One article: its draft and, if published, what's live."""
        return self.request("GET", f"/articles/{_e(id)}", query=None, idempotency_key=idempotency_key)

    def update_article(self, id, body, *, idempotency_key=None):
        """Update an article's draft. Change the draft's title or text. What's live doesn't change until it's published again."""
        return self.request("PATCH", f"/articles/{_e(id)}", query=None, body=body, idempotency_key=idempotency_key)

    def publish_article(self, id, *, idempotency_key=None):
        """Publish an article. Put the draft live (wherever it's placed: help centers, Zoe, the inbox)."""
        return self.request("POST", f"/articles/{_e(id)}/publish", query=None, idempotency_key=idempotency_key)

    def list_knowledge_records(self, *, source=None, per_page=None, starting_after=None, idempotency_key=None):
        """List knowledge. Everything Zoe and the inbox may draw on: articles, internal articles, snippets, files and synced pages."""
        return self.request("GET", "/knowledge_records", query={"source": source, "per_page": per_page, "starting_after": starting_after}, idempotency_key=idempotency_key)

    def iter_list_knowledge_records(self, *, source=None, per_page=None):
        """Every page of list_knowledge_records, item by item."""
        after = None
        while True:
            page = self.list_knowledge_records(source=source, per_page=per_page, starting_after=after)
            yield from page["data"]
            after = page["pages"]["next"]
            if not after:
                return

    def get_knowledge_record(self, id, *, idempotency_key=None):
        """Retrieve knowledge. One knowledge record."""
        return self.request("GET", f"/knowledge_records/{_e(id)}", query=None, idempotency_key=idempotency_key)

    def list_macros(self, *, idempotency_key=None):
        """List macros. Shared macros, and the token's teammate's own."""
        return self.request("GET", "/macros", query=None, idempotency_key=idempotency_key)

    def get_macro(self, id, *, idempotency_key=None):
        """Retrieve a macro. One macro: its text and its actions."""
        return self.request("GET", f"/macros/{_e(id)}", query=None, idempotency_key=idempotency_key)

    def apply_macro(self, id, body, *, idempotency_key=None):
        """Apply a macro. Apply a macro to a conversation: its reply or note, and its actions. Send `Idempotency-Key` to make retries safe."""
        return self.request("POST", f"/conversations/{_e(id)}/macros", query=None, body=body, idempotency_key=idempotency_key)

    def list_workflows(self, *, idempotency_key=None):
        """List workflows. The workspace's workflows (archived ones left out)."""
        return self.request("GET", "/workflows", query=None, idempotency_key=idempotency_key)

    def get_workflow(self, id, *, idempotency_key=None):
        """Retrieve a workflow. One workflow."""
        return self.request("GET", f"/workflows/{_e(id)}", query=None, idempotency_key=idempotency_key)

    def list_workflow_runs(self, id, *, per_page=None, starting_after=None, idempotency_key=None):
        """List a workflow's runs. Its runs, newest first."""
        return self.request("GET", f"/workflows/{_e(id)}/runs", query={"per_page": per_page, "starting_after": starting_after}, idempotency_key=idempotency_key)

    def iter_list_workflow_runs(self, id, *, per_page=None):
        """Every page of list_workflow_runs, item by item."""
        after = None
        while True:
            page = self.list_workflow_runs(id, per_page=per_page, starting_after=after)
            yield from page["data"]
            after = page["pages"]["next"]
            if not after:
                return

    def trigger_workflow(self, id, body, *, idempotency_key=None):
        """Run a workflow. Run a live, manually triggered workflow on a conversation. It runs in the background."""
        return self.request("POST", f"/workflows/{_e(id)}/trigger", query=None, body=body, idempotency_key=idempotency_key)

    def list_outbound_messages(self, *, idempotency_key=None):
        """List outbound messages. Chats and banners, with what they reached."""
        return self.request("GET", "/outbound_messages", query=None, idempotency_key=idempotency_key)

    def get_outbound_message(self, id, *, idempotency_key=None):
        """Retrieve an outbound message. One outbound message and its numbers."""
        return self.request("GET", f"/outbound_messages/{_e(id)}", query=None, idempotency_key=idempotency_key)

    def list_data_attributes(self, *, model=None, idempotency_key=None):
        """List data attributes. The workspace's attributes for conversations and contacts."""
        return self.request("GET", "/data_attributes", query={"model": model}, idempotency_key=idempotency_key)

    def create_data_attribute(self, body, *, idempotency_key=None):
        """Create a conversation attribute. A new attribute teammates fill in on conversations."""
        return self.request("POST", "/data_attributes", query=None, body=body, idempotency_key=idempotency_key)

    def list_segments(self, *, idempotency_key=None):
        """List segments. Saved and built-in segments of contacts."""
        return self.request("GET", "/segments", query=None, idempotency_key=idempotency_key)

    def list_segment_contacts(self, id, *, per_page=None, starting_after=None, idempotency_key=None):
        """List a segment's contacts. Who's in a segment now."""
        return self.request("GET", f"/segments/{_e(id)}/contacts", query={"per_page": per_page, "starting_after": starting_after}, idempotency_key=idempotency_key)

    def iter_list_segment_contacts(self, id, *, per_page=None):
        """Every page of list_segment_contacts, item by item."""
        after = None
        while True:
            page = self.list_segment_contacts(id, per_page=per_page, starting_after=after)
            yield from page["data"]
            after = page["pages"]["next"]
            if not after:
                return

    def create_export(self, body, *, idempotency_key=None):
        """Export data. Start an export of conversations, contacts and/or tickets (as newline-delimited JSON). It runs in the background; fetch it to see when it's ready."""
        return self.request("POST", "/exports", query=None, body=body, idempotency_key=idempotency_key)

    def get_export(self, id, *, idempotency_key=None):
        """Retrieve an export. Its progress, and when it's done, links to its files (each valid for an hour)."""
        return self.request("GET", f"/exports/{_e(id)}", query=None, idempotency_key=idempotency_key)

    def list_webhooks(self, *, idempotency_key=None):
        """List webhooks. The workspace's webhook subscriptions."""
        return self.request("GET", "/webhooks", query=None, idempotency_key=idempotency_key)

    def create_webhook(self, body, *, idempotency_key=None):
        """Create a webhook. Subscribe a public https address to topics. The response carries its signing `secret`, this once."""
        return self.request("POST", "/webhooks", query=None, body=body, idempotency_key=idempotency_key)

    def get_webhook(self, id, *, idempotency_key=None):
        """Retrieve a webhook. One webhook subscription and its state."""
        return self.request("GET", f"/webhooks/{_e(id)}", query=None, idempotency_key=idempotency_key)

    def update_webhook(self, id, body, *, idempotency_key=None):
        """Update a webhook. Change its address, topics or alert email, or turn it off or back on (back on forgives its failures)."""
        return self.request("PATCH", f"/webhooks/{_e(id)}", query=None, body=body, idempotency_key=idempotency_key)

    def delete_webhook(self, id, *, idempotency_key=None):
        """Delete a webhook. Stop sending to it; deliveries still waiting are abandoned."""
        return self.request("DELETE", f"/webhooks/{_e(id)}", query=None, idempotency_key=idempotency_key)

    def rotate_webhook_secret(self, id, *, idempotency_key=None):
        """Rotate a webhook's secret. A new signing secret (returned this once). For 24 hours, deliveries are signed with both, so you can switch without missing any."""
        return self.request("POST", f"/webhooks/{_e(id)}/rotate_secret", query=None, idempotency_key=idempotency_key)

    def test_webhook(self, id, *, idempotency_key=None):
        """Send a test delivery. A `ping` delivery, to check the address and your signature check."""
        return self.request("POST", f"/webhooks/{_e(id)}/test", query=None, idempotency_key=idempotency_key)

    def list_webhook_deliveries(self, id, *, per_page=None, starting_after=None, idempotency_key=None):
        """List deliveries. What was sent to it, newest first (kept 30 days)."""
        return self.request("GET", f"/webhooks/{_e(id)}/deliveries", query={"per_page": per_page, "starting_after": starting_after}, idempotency_key=idempotency_key)

    def iter_list_webhook_deliveries(self, id, *, per_page=None):
        """Every page of list_webhook_deliveries, item by item."""
        after = None
        while True:
            page = self.list_webhook_deliveries(id, per_page=per_page, starting_after=after)
            yield from page["data"]
            after = page["pages"]["next"]
            if not after:
                return

    def get_webhook_delivery(self, id, delivery_id, *, idempotency_key=None):
        """Retrieve a delivery. One delivery: its body, and every attempt with what came back."""
        return self.request("GET", f"/webhooks/{_e(id)}/deliveries/{_e(delivery_id)}", query=None, idempotency_key=idempotency_key)

    def replay_webhook_delivery(self, id, delivery_id, *, idempotency_key=None):
        """Replay a delivery. Send the same event and body again, as a new delivery."""
        return self.request("POST", f"/webhooks/{_e(id)}/deliveries/{_e(delivery_id)}/replay", query=None, idempotency_key=idempotency_key)
