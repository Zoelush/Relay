-- Data-preserving rollback: keep the column and reference table. The previous application
-- version treats every upload as a part, so an inline upload still scanning at rollback is
-- published as a separate attachment part (internal images stay internal). Sent messages keep
-- their image nodes; the previous renderer shows their plain-text "[Image]" fallback.
SELECT 1;
