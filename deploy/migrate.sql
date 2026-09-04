-- Additive channels tables for existing Janus databases.
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

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS chat_key text NOT NULL DEFAULT '';
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_user_id_bot_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS conversations_user_bot_chat_idx ON conversations (user_id, bot_id, chat_key);

CREATE TABLE IF NOT EXISTS business_connections (
  connection_id text PRIMARY KEY,
  telegram_user_id bigint NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  rights jsonb NOT NULL DEFAULT '{}',
  auto_reply boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
