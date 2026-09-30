-- Data-preserving rollback: keep both tables and the trigger. The previous application version
-- neither reads nor writes them; mentions in stored notes render as their "@name" text fallback.
-- Views using the `mentioned` filter fail validation on the previous version: archive them
-- (or restore this version) before rolling back the application.
SELECT 1;
