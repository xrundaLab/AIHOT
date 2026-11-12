CREATE INDEX CONCURRENTLY IF NOT EXISTS article_reviews_source_idx ON article_reviews (source_hash, created_at DESC);
