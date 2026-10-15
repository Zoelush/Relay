-- Rollback for 0071_people_data: the flag goes off, so events are refused, the People area,
-- Settings' events and subscriptions pages and the preference page close. Events, subscription
-- choices and segments stay, and a delivery of a subscription type is still checked.
UPDATE workspace_features SET enabled=false WHERE name='segments_v1';
