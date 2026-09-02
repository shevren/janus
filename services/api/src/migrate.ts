import { pool } from "./db.js";

const SQL = `
CREATE TABLE IF NOT EXISTS github_connections (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  login text NOT NULL,
  token_enc text NOT NULL,
  scopes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telegram_accounts (
  telegram_user_id bigint PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username text
);

CREATE TABLE IF NOT EXISTS telegram_chats (
  chat_id bigint PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'dm'
);

CREATE TABLE IF NOT EXISTS telegram_link_codes (
  code text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

ALTER TABLE bots ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'ask';
`;

export async function migrate() {
  await pool.query(SQL);
}
