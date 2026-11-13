-- Rollback for 0102_test_workspace: no pairing anywhere. Each test workspace stops being the test
-- of anything, so nobody can switch into it and the earlier code treats it as an ordinary
-- workspace of its own — which is what it is. Its rows, and what it would have sent, stay.
-- Anyone who needs it gone deletes that workspace deliberately, as they would any other.
UPDATE workspace SET test_of=NULL,test_workspace_id=NULL WHERE test_of IS NOT NULL OR test_workspace_id IS NOT NULL;
