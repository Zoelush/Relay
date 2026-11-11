-- Invoices and the payment port (phase 16, step C10a; docs/SECURITY_STEP20.md). Additive.
-- One invoice per billing period, issued at its start: the plan's full seats in advance, the last
-- period's prorated seat additions and metered usage, and tax (zero for now). Each line is frozen
-- with the records it counts, so a dispute is checked line by line. Relay issues invoices; the
-- payment provider keeps the card (Relay keeps its brand, last 4 and expiry) and charges totals.

-- The workspace's billing contact, address and tax id.
CREATE TABLE billing_profiles (
 workspace_id text PRIMARY KEY REFERENCES workspace(id),
 email text NOT NULL DEFAULT '' CHECK(length(email) <= 254),
 name text NOT NULL DEFAULT '' CHECK(length(name) <= 200),
 address_line1 text NOT NULL DEFAULT '' CHECK(length(address_line1) <= 200),
 address_line2 text NOT NULL DEFAULT '' CHECK(length(address_line2) <= 200),
 city text NOT NULL DEFAULT '' CHECK(length(city) <= 100),
 postal_code text NOT NULL DEFAULT '' CHECK(length(postal_code) <= 20),
 country text NOT NULL DEFAULT '' CHECK(country = '' OR country ~ '^[A-Z]{2}$'),
 tax_id text NOT NULL DEFAULT '' CHECK(length(tax_id) <= 40),
 updated_by text, updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE billing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON billing_profiles USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON billing_profiles FOR EACH ROW EXECUTE FUNCTION audit_row('billing_profile','workspace','workspace_id','');

-- The provider's customer and the card on file (never the card's number: only what identifies it).
CREATE TABLE billing_customers (
 workspace_id text PRIMARY KEY REFERENCES workspace(id),
 provider text NOT NULL CHECK(provider IN ('stripe','stand-in')),
 customer_id text NOT NULL,
 payment_method_id text,
 card_brand text, card_last4 text CHECK(card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
 card_exp_month integer CHECK(card_exp_month BETWEEN 1 AND 12), card_exp_year integer,
 updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE billing_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON billing_customers USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
CREATE TRIGGER audit AFTER INSERT OR UPDATE OF payment_method_id ON billing_customers FOR EACH ROW EXECUTE FUNCTION audit_row('billing_card','workspace','workspace_id','card_last4');

-- One sequence for all of Relay's invoices (RLY-2026-000123). A number taken by a transaction that
-- fails is lost, leaving a gap (documented).
CREATE SEQUENCE invoice_number_seq;

CREATE TABLE invoices (
 workspace_id text NOT NULL REFERENCES workspace(id),
 id text NOT NULL,
 number text NOT NULL UNIQUE,
 period_start timestamptz NOT NULL, period_end timestamptz NOT NULL CHECK(period_end > period_start),
 plan text NOT NULL,
 -- unpriced: a price is still a placeholder (never charged); open: to pay; paid; failed; void.
 status text NOT NULL CHECK(status IN ('unpriced','open','paid','failed','void')),
 currency text NOT NULL DEFAULT 'usd',
 subtotal_cents integer, tax_cents integer, total_cents integer,
 CHECK((status = 'unpriced') = (total_cents IS NULL)),
 issued_at timestamptz NOT NULL DEFAULT now(),
 paid_at timestamptz,
 payment_ref text,
 failure text NOT NULL DEFAULT '',
 attempts integer NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,period_start));
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON invoices USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
CREATE TRIGGER audit AFTER INSERT OR UPDATE OF status ON invoices FOR EACH ROW EXECUTE FUNCTION audit_row('invoice','invoice','id','number');

CREATE TABLE invoice_lines (
 workspace_id text NOT NULL, invoice_id text NOT NULL, id text NOT NULL,
 seq integer NOT NULL,
 kind text NOT NULL CHECK(kind IN ('seats','proration','usage','tax')),
 meter text,
 description text NOT NULL,
 quantity numeric NOT NULL,
 unit_cents numeric,
 amount_cents integer,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,invoice_id) REFERENCES invoices(workspace_id,id));
CREATE INDEX invoice_lines_invoice ON invoice_lines(workspace_id,invoice_id,seq);
ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON invoice_lines USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));

-- What each line counts, frozen: the source record's id, time and quantity (a meter's unit, a seat).
CREATE TABLE invoice_line_units (
 workspace_id text NOT NULL, line_id text NOT NULL, source_id text NOT NULL,
 at timestamptz NOT NULL, quantity numeric NOT NULL,
 conversation_id text, contact_id text, detail text NOT NULL DEFAULT '',
 PRIMARY KEY(workspace_id,line_id,source_id),
 FOREIGN KEY(workspace_id,line_id) REFERENCES invoice_lines(workspace_id,id));
CREATE INDEX invoice_line_units_page ON invoice_line_units(workspace_id,line_id,at,source_id);
ALTER TABLE invoice_line_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_units FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON invoice_line_units USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));

-- Issued is issued: lines and units never change; an invoice only changes its status and payment.
CREATE FUNCTION invoice_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'invoices' AND TG_OP = 'UPDATE'
     AND (NEW.number, NEW.period_start, NEW.period_end, NEW.plan, NEW.currency, NEW.subtotal_cents, NEW.tax_cents, NEW.total_cents, NEW.issued_at)
         IS NOT DISTINCT FROM (OLD.number, OLD.period_start, OLD.period_end, OLD.plan, OLD.currency, OLD.subtotal_cents, OLD.tax_cents, OLD.total_cents, OLD.issued_at)
     AND (OLD.status <> 'unpriced' OR NEW.status = 'void') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Issued invoices are append-only: only an invoice''s status and payment change.' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER frozen BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION invoice_frozen();
CREATE TRIGGER frozen BEFORE UPDATE OR DELETE ON invoice_lines FOR EACH ROW EXECUTE FUNCTION invoice_frozen();
CREATE TRIGGER frozen BEFORE UPDATE OR DELETE ON invoice_line_units FOR EACH ROW EXECUTE FUNCTION invoice_frozen();

-- The provider's webhook events, each taken once.
CREATE TABLE payment_events (
 workspace_id text NOT NULL REFERENCES workspace(id),
 id text NOT NULL, type text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id));
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON payment_events USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));

-- Settings › Billing › Invoices, and issuing invoices, are behind `billing_v1`, off by default.
INSERT INTO workspace_features(workspace_id,name,enabled) SELECT id,'billing_v1',false FROM workspace ON CONFLICT DO NOTHING;
