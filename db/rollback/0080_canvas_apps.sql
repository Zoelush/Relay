-- Rollback for 0080_canvas_apps: no app draws anywhere (every placement removed) and the cards on
-- screen are forgotten. The columns and tables stay, and the logs are kept.
UPDATE oauth_apps SET canvas_placements='{}' WHERE canvas_placements<>'{}';
DELETE FROM canvas_sessions;
