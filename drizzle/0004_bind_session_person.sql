-- Existing sessions know the subject but cannot prove its owner at sign-in.
-- Leave them unbound so the new web image requires a fresh sign-in.
ALTER TABLE "auth_session" ADD COLUMN "oidc_person_id" uuid;--> statement-breakpoint
CREATE FUNCTION bind_session_person() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Older web images can still insert during an upgrade or rollback.
  IF NEW."oidc_person_id" IS NULL THEN
    RETURN NEW;
  END IF;

  -- Hold the person row until the insert commits. Directory sync takes a
  -- conflicting row lock before revoking sessions for a changed subject.
  PERFORM 1
  FROM "person"
  WHERE "id" = NEW."oidc_person_id"
    AND "oidc_subject" = NEW."oidc_subject"
    AND "has_access"
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The OIDC subject no longer belongs to the admitted person'
      USING ERRCODE = '23514', CONSTRAINT = 'logbook_session_person_binding';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER bind_session_person BEFORE INSERT ON "auth_session"
FOR EACH ROW EXECUTE FUNCTION bind_session_person();
