CREATE INDEX CONCURRENTLY IF NOT EXISTS article_reviews_article_idx ON article_reviews (article_id, created_at DESC);
