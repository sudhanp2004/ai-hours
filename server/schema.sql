-- AI Hours sync backend (spec §13). Neon project "ai-hours" (frosty-voice-43050652), Singapore.
-- Applied 2026-10-05. Row-level security policies are added in step 2, once the Data API is
-- provisioned with Google as its token provider (that creates auth.user_id()).

-- 1. The table: only what totals need. No conversation ids, never any text.
CREATE TABLE public.records (
  user_id      text    NOT NULL,                       -- Google's opaque `sub`, from the token
  id           text    NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  site         text    NOT NULL CHECK (site IN ('chatgpt', 'perplexity', 'claude', 'gemini', 'deepseek')),
  model        text    CHECK (model IS NULL OR length(model) <= 64),
  start_ms     bigint  NOT NULL,
  end_ms       bigint  CHECK (end_ms IS NULL OR (end_ms >= start_ms AND end_ms - start_ms <= 10800000)),
  last_seen    bigint  CHECK (last_seen IS NULL OR last_seen >= start_ms),
  outcome      text    NOT NULL CHECK (outcome IN ('unknown', 'completed', 'stopped', 'error', 'pending', 'recovered')),
  recovered_ms integer CHECK (recovered_ms IS NULL OR recovered_ms BETWEEN 0 AND 10800000),
  updated_ms   bigint  NOT NULL,                       -- last writer wins
  PRIMARY KEY (user_id, id)
);

-- Nothing dated in the future (10 min of clock skew allowed), and an older copy never
-- overwrites a newer one. Same limits as the extension (spec §12).
CREATE FUNCTION public.records_sane() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE now_ms bigint := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
BEGIN
  IF NEW.start_ms > now_ms + 600000 OR NEW.updated_ms > now_ms + 600000 OR coalesce(NEW.last_seen, 0) > now_ms + 600000 OR coalesce(NEW.end_ms, 0) > now_ms + 600000 THEN
    RAISE EXCEPTION 'record % is dated in the future', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.updated_ms < OLD.updated_ms THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER records_sane BEFORE INSERT OR UPDATE ON public.records FOR EACH ROW EXECUTE FUNCTION public.records_sane();

-- Locked until policies exist: RLS on with no policy means no API access at all.
ALTER TABLE public.records ENABLE ROW LEVEL SECURITY;

-- 2. Data API (applied 2026-10-05 through the Neon API, not SQL):
--    auth provider external "Google Identity", JWKS https://www.googleapis.com/oauth2/v3/certs,
--    audience 822593684452-t3f70ule6u8nfms79s9nl25h0snhe8st.apps.googleusercontent.com,
--    default grants (authenticated: select/insert/update/delete; anonymous: nothing),
--    CORS * (the token and RLS are the security; extensions can't be named in CORS),
--    max 1000 rows per response.
--    Endpoint: https://ep-little-union-b38xtax2.apirest.c-4.ap-southeast-1.aws.neon.tech/neondb/rest/v1
--    Checked: requests with no token or a forged token are refused.

-- 3. Each user reaches only their own rows; user_id is filled from the token, never the client.
ALTER TABLE public.records ALTER COLUMN user_id SET DEFAULT (auth.user_id());
CREATE POLICY "own rows" ON public.records FOR ALL TO authenticated
  USING ((SELECT auth.user_id()) = user_id) WITH CHECK ((SELECT auth.user_id()) = user_id);

-- 4. Incremental pulls ask for one user's rows changed since a time, in that order.
CREATE INDEX records_user_updated ON public.records (user_id, updated_ms, id);
