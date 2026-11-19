CREATE INDEX CONCURRENTLY IF NOT EXISTS radar_body_tasks_state_idx ON radar_body_tasks (state, updated_at, id);
