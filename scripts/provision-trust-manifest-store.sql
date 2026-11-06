-- Run as a trust-store database administrator, not as the ORIENT runtime role.
-- Create the orient_trust_manifest_runtime role separately with LOGIN and a
-- credential delivered only to the separately operated trust-store service.

CREATE TABLE IF NOT EXISTS public.orient_trust_manifest_state (
  singleton_id text PRIMARY KEY CHECK (singleton_id = 'active'),
  version bigint NOT NULL CHECK (version > 0),
  digest char(64) NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION public.orient_trust_manifest_state_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.singleton_id <> OLD.singleton_id OR NEW.version <= OLD.version THEN
      RAISE EXCEPTION 'trust manifest state must advance monotonically'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'trust manifest state is append-forward only'
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS orient_trust_manifest_state_update_guard
  ON public.orient_trust_manifest_state;
CREATE TRIGGER orient_trust_manifest_state_update_guard
  BEFORE UPDATE ON public.orient_trust_manifest_state
  FOR EACH ROW EXECUTE FUNCTION public.orient_trust_manifest_state_guard();

DROP TRIGGER IF EXISTS orient_trust_manifest_state_delete_guard
  ON public.orient_trust_manifest_state;
CREATE TRIGGER orient_trust_manifest_state_delete_guard
  BEFORE DELETE ON public.orient_trust_manifest_state
  FOR EACH ROW EXECUTE FUNCTION public.orient_trust_manifest_state_guard();

DROP TRIGGER IF EXISTS orient_trust_manifest_state_truncate_guard
  ON public.orient_trust_manifest_state;
CREATE TRIGGER orient_trust_manifest_state_truncate_guard
  BEFORE TRUNCATE ON public.orient_trust_manifest_state
  FOR EACH STATEMENT EXECUTE FUNCTION public.orient_trust_manifest_state_guard();

REVOKE ALL ON public.orient_trust_manifest_state FROM PUBLIC;
REVOKE ALL ON FUNCTION public.orient_trust_manifest_state_guard() FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.orient_trust_manifest_state
  TO orient_trust_manifest_runtime;
