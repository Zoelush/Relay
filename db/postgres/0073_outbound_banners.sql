-- Outbound banners (phase 13, step O3; docs/OUTBOUND_STEP3.md): a second type of message, shown at
-- the top or bottom of the customer's page, behind `outbound_v1`. The type's check widens
-- (additive: every existing row still passes).
ALTER TABLE outbound_messages DROP CONSTRAINT outbound_messages_type_check;
ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_type_check CHECK(type IN ('chat','banner'));
