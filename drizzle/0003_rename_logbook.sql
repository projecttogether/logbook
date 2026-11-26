-- PostgreSQL triggers keep their bindings when the trigger functions are renamed.
ALTER FUNCTION logbuch_forbid_delete() RENAME TO logbook_forbid_delete;
--> statement-breakpoint
ALTER FUNCTION logbuch_forbid_entry_delete() RENAME TO logbook_forbid_entry_delete;
--> statement-breakpoint
ALTER FUNCTION logbuch_forbid_delete_unless_draft() RENAME TO logbook_forbid_delete_unless_draft;
--> statement-breakpoint
ALTER FUNCTION logbuch_forbid_update() RENAME TO logbook_forbid_update;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION logbook_forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Logbook never deletes rows from %', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION logbook_forbid_delete_unless_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM entry WHERE entry.id = OLD.entry_id AND entry.status = 'draft') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Logbook never deletes rows from %', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
