CREATE TABLE IF NOT EXISTS radar_body_tasks (
  id bigserial PRIMARY KEY,
  identity_key text UNIQUE,
  article_id text REFERENCES articles(id) ON DELETE SET NULL,
  title text NOT NULL,
  url text,
  origin text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','external','leased','complete','manual')),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  lease_token text,
  lease_until timestamptz,
  leased_revision integer,
  result_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
