-- Lets an admin look up a student's password again (for students who forgot it and did not write it down).
-- The password is stored ENCRYPTED (AES-GCM, key kept in a Cloudflare secret, never in the database).
-- Login still uses password_hash. Students registered before this migration have NULL here:
-- their old passwords were never saved, so the admin resets them once and the new one is viewable from then on.

ALTER TABLE students ADD COLUMN password_enc TEXT;
