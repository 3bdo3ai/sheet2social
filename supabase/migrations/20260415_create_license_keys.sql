DO $$ BEGIN
  CREATE TYPE public.license_status AS ENUM ('active', 'paused', 'expired', 'revoked');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.license_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_string text NOT NULL UNIQUE,
  status public.license_status NOT NULL DEFAULT 'active',
  device_id text,
  valid_until timestamptz NOT NULL,
  user_name text,
  user_phone text,
  user_email text,
  admin_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT license_keys_key_string_len_chk CHECK (char_length(key_string) = 24),
  CONSTRAINT license_keys_key_string_charset_chk CHECK (key_string ~ '^[!-~]{24}$')
);

CREATE INDEX IF NOT EXISTS license_keys_status_idx ON public.license_keys(status);
CREATE INDEX IF NOT EXISTS license_keys_valid_until_idx ON public.license_keys(valid_until);
CREATE INDEX IF NOT EXISTS license_keys_device_id_idx ON public.license_keys(device_id) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS license_keys_status_valid_until_idx ON public.license_keys(status, valid_until);

CREATE OR REPLACE FUNCTION public.set_license_keys_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_license_keys_updated_at ON public.license_keys;
CREATE TRIGGER trg_set_license_keys_updated_at
BEFORE UPDATE ON public.license_keys
FOR EACH ROW
EXECUTE FUNCTION public.set_license_keys_updated_at();

ALTER TABLE public.license_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "license_keys_service_role_all" ON public.license_keys;
CREATE POLICY "license_keys_service_role_all"
ON public.license_keys
FOR ALL
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "license_keys_deny_anon" ON public.license_keys;
CREATE POLICY "license_keys_deny_anon"
ON public.license_keys
FOR ALL
TO anon, authenticated
USING (false)
WITH CHECK (false);
