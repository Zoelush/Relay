-- Data-preserving rollback: keep the macros table and the granted capabilities. The previous
-- application version has no macro routes; `macros.manage` keeps its meaning throughout.
SELECT 1;
