-- Rollback for 0098_help_center_design: every help center is live again, as the earlier code
-- assumes (it serves them all). Themes saved by the rebuild stay as they are: the earlier code
-- reads only the fields it knows and draws its default look for the rest. Uploaded images stay.
UPDATE help_centers SET live=true WHERE NOT live;
