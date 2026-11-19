CREATE TABLE IF NOT EXISTS radar_body_activation (id boolean PRIMARY KEY DEFAULT true CHECK (id), activated_at timestamptz NOT NULL DEFAULT now());
