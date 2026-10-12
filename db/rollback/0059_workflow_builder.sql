-- Rollback for 0059_workflow_builder: the previous version has no builder and ignores `layout`,
-- so nothing needs turning off. Card positions are cleared so a later re-deploy lays out afresh
-- (the builder tidies up any workflow without them). Drafts, versions and runs are untouched.
UPDATE workflows SET layout='{}' WHERE layout<>'{}';
