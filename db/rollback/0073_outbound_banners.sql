-- Rollback for 0073_outbound_banners: live banners are paused, so none is shown again. Banner
-- rows stay (the wider check stays with them), with their ledger.
UPDATE outbound_messages SET state='paused',updated_at=now() WHERE type='banner' AND state='live';
