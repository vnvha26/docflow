-- Auth constraints are added with the auth module. Existing migrations stay immutable.
ALTER TABLE "User"
  ADD CONSTRAINT "User_email_normalized_check"
    CHECK ("email" = lower(btrim("email")) AND position('@' IN "email") > 1),
  ADD CONSTRAINT "User_timezone_format_check"
    CHECK ("timezone" ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'),
  ADD CONSTRAINT "User_revision_check" CHECK ("revision" >= 1);

ALTER TABLE "Session"
  ADD CONSTRAINT "Session_refreshTokenHash_hex_check"
    CHECK ("refreshTokenHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "Session_expiry_check" CHECK ("expiresAt" > "createdAt");
