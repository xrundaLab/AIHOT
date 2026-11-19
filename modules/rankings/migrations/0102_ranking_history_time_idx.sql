CREATE INDEX CONCURRENTLY IF NOT EXISTS ranking_history_time_idx ON external_ranking_snapshots (fetched_at DESC, board_id) WHERE status = 'complete';
