-- Rollback for 0093_seats: the ledger stops being written (the earlier code doesn't read it), and
-- every limited seat goes back to full, since the earlier code gives limited seats nothing less.
-- The table, its rows and the period anchor stay.
DROP TRIGGER IF EXISTS seat_change ON teammates;
UPDATE teammates SET seat='full' WHERE seat='limited';
