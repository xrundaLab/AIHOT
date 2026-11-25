-- Only results made with a recorded request configuration can be reused.
ALTER TABLE external_ranking_snapshots ADD COLUMN screen_signature text;
