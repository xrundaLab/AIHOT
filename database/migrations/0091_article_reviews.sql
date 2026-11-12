CREATE TABLE article_reviews (
  id uuid PRIMARY KEY,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  vote text NOT NULL CHECK (vote IN ('up', 'down')),
  note text CHECK (char_length(note) <= 1000),
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
