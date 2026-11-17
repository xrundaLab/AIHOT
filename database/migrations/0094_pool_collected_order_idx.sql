CREATE INDEX CONCURRENTLY IF NOT EXISTS publications_pool_collected_order_idx
  ON publications (discovered_at DESC NULLS LAST, article_id DESC)
  WHERE visibility = 'public' AND eligible;
