-- Finishing phase 01, P2a (docs/PEOPLE_STEP4.md): a segment is made of people (as every segment
-- so far) or of companies. Additive: existing segments are people. Definitions may now hold groups
-- of rules and tag and company rules, which are JSON, so they need no change here.
ALTER TABLE segments ADD COLUMN target text NOT NULL DEFAULT 'contacts' CHECK(target IN ('contacts','companies'));
