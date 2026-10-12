-- The workflow builder (phase 11, step W2; docs/WORKFLOWS_STEP2.md), behind `workflows_v1`. Additive.

-- Where each card sits on the builder's canvas (`trigger` and each path's letter: {x,y}). It
-- belongs to the workflow, not to a version, so moving cards is never an unpublished change.
ALTER TABLE workflows ADD COLUMN layout jsonb NOT NULL DEFAULT '{}';
