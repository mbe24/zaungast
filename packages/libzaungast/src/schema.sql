-- ChatStore schema — the SINGLE source of truth for the ingest DB's DDL.
-- Read once by TS (ingest/store.ts) and handed VERBATIM to the native engine
-- (libzaungast-native's build_store) as a string; there is exactly one reader,
-- so the CREATE TABLE / index definitions cannot drift between the two engines.
-- The load-bearing column comments live here (SQLite ignores `--` comments), so
-- they travel WITH the DDL as one copy. FTS is created separately by each engine
-- (it is conditional on fts5 availability), so it is intentionally NOT in here.
create table conversations(
  id text primary key, handle text unique, kind text,
  -- meta, written from conversation records. thread_type = Teams' OWN conversation-type
  -- string (chat/channel/meeting/space/engagecommunity/…), faithful and distinct from the
  -- id-derived "kind"; persisted so future team/community consumers can identify roots
  -- (space) and communities (engagecommunity) by Teams' value, not id-pattern guessing.
  topic text, team_id text, thread_type text, meta_last_ts integer default 0,
  -- derived, recomputed from messages:
  msg_count integer default 0, participant_names text, participant_count integer default 0,
  activity_ts integer default 0, last_ts integer default 0
);
create table people(
  mri text primary key, handle text unique, name text,
  msg_count integer default 0, last_ts integer default 0
);
-- Name source from the Teams profiles store, independent of who posted. recomputeDerived
-- rebuilds people from message senders only, so a reactor/mention who never posted has no
-- people row — profiles fills that gap (26% of reactors in real data). Never cleared by the
-- derived recompute; reconciled directly by the ingest profiles pass.
create table profiles(mri text primary key, name text);
-- chain_key: the owning reply-chain record's leveldb key, HEX-encoded. It must be hex, not
-- the raw latin1 bytes: leveldb keys contain embedded NUL bytes, and node:sqlite truncates a
-- TEXT value at the first NUL on JS read-back (a plain SELECT would return '' for real keys).
-- Hex is NUL-free so it round-trips; ingest encodes both this column and the reconcile's
-- live-key set the same way. (Regression-guarded in test/fixture/verify.ts.)
-- root_id: the id of the reply-chain root this message belongs to (a channel thread key).
-- Teams marks the root with parentMessageId === its own id, and every reply's parentMessageId
-- is the root's id; ingest derives root_id from that. root_id === id ⇒ this message is a root.
-- In 1:1/group chats each message is its own root (unthreaded); only channels render threaded.
create table messages(
  conv_id text, id text, chain_key text, version integer default 0, ts integer,
  sender_mri text, sender_name text, kind text, is_mine integer default 0,
  is_system integer default 0, has_attach integer default 0, mentions_me integer default 0,
  content text, reactions text, root_id text,
  primary key(conv_id, id)
);
create index msg_conv_ts on messages(conv_id, ts);
create index msg_sender_ts on messages(sender_mri, ts);
create index msg_ts on messages(ts);
create index msg_chain on messages(chain_key);
create index msg_root on messages(conv_id, root_id, ts);
create table events(
  id text primary key,
  series_id text,              -- seriesMasterId; groups a recurring series (one c: handle + run-collapse)
  kind text,                   -- 'meeting' | 'appointment' (cid-first, computed at ingest)
  subject text,
  start_ts integer default 0,
  end_ts integer default 0,
  is_all_day integer default 0,
  location text,
  organizer_name text,
  organizer_email text,
  cid text,                    -- 19:meeting_ thread id (meetings only) for chat pivot; null otherwise
  my_response text,            -- Accepted/Tentative/Declined/None
  show_as text,                -- Busy/Free/Tentative/OOF
  is_cancelled integer default 0,
  is_confidential integer default 0,  -- sensitivityLabelId truthy OR doNotForward
  has_attach integer default 0,
  attendees text,              -- compact JSON [{n,e,r}] = name,email,response; capped at render
  body_html text               -- raw bodyContent; used ONLY behind include_body
);
create index events_start on events(start_ts);
create index events_series on events(series_id);
create table calls(
  id text primary key,         -- callId
  call_type text,              -- TwoParty/MultiParty/… (verbatim; no fixed enum)
  direction text,              -- Outgoing/Incoming
  state text,                  -- callState verbatim
  is_missed integer default 0, -- derived from callState (Missed only; see applyCalls)
  start_ts integer default 0,
  duration_ms integer default 0,
  counterpart_mri text,        -- TwoParty other party: target if Outgoing else originator (its .id)
  participants text,           -- compact JSON [{mri,name}] for MultiParty
  group_thread_id text,        -- groupChatThreadId (19:…@thread.v2) for MultiParty chat pivot
  has_recording integer default 0,
  recording_link text,         -- JSON {conversationId, linkedMessageId} for get_message pivot
  has_voicemail integer default 0,
  spam_level text,             -- spamRiskLevel; render [spam?] only when risky (non-null/none)
  is_current_user_part integer default 1,
  is_deleted integer default 0 -- filtered by default
);
create index calls_start on calls(start_ts);
