-- Enables btree_gist, needed later by the booking overlap exclusion constraint
-- (design: database-enforced booking overlap). No business tables here (task 2.1).
create extension if not exists btree_gist;
