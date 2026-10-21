-- Rollback for 0082_role_scope: every role sees every conversation again, and the guard goes.
-- The scope column and the security.manage grants stay.
DROP TRIGGER IF EXISTS role_scope_guard ON role_capabilities;
DROP TRIGGER IF EXISTS role_scope_guard ON roles;
UPDATE roles SET scope='all' WHERE scope<>'all';
