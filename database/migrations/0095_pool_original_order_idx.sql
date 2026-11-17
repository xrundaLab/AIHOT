CREATE INDEX CONCURRENTLY IF NOT EXISTS publications_pool_original_order_idx
  ON publications (published_at DESC NULLS LAST, article_id DESC)
  WHERE visibility = 'public' AND eligible;
