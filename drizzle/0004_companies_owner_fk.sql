-- 004 — the other half of the circular reference.
--
-- Separated from 002 only because `users` did not exist yet. The column stays
-- nullable and is set inside the signup transaction once the first user row
-- exists (06 §3). A deferrable constraint would also work and is worse: it
-- defers to COMMIT, so a violation surfaces detached from the statement that
-- caused it, in a transaction that has already done all its other work.

ALTER TABLE companies
  ADD CONSTRAINT fk_companies_owner_user
  FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE SET NULL;
