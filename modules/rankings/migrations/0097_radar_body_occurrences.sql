CREATE TABLE IF NOT EXISTS radar_body_occurrences (
  snapshot_id bigint NOT NULL REFERENCES external_ranking_snapshots(id) ON DELETE CASCADE,
  rank integer NOT NULL,
  task_id bigint NOT NULL REFERENCES radar_body_tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (snapshot_id, rank)
);
