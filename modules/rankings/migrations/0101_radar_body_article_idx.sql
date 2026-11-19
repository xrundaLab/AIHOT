CREATE INDEX CONCURRENTLY IF NOT EXISTS radar_body_article_idx ON radar_body_tasks (article_id) WHERE article_id IS NOT NULL;
