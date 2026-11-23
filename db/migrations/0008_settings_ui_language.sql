-- Task 9.1 gate fix: per-tenant UI language (EN | ID) for the owner workspace.
-- One column on the existing settings row. RLS (enabled and forced on settings in 0002/0003) and the
-- runtime grants (select, insert, update on settings) are table-level, so they cover the new column
-- unchanged; nothing is granted or relaxed here. Existing rows take the default 'en'.
alter table settings
  add column ui_language text not null default 'en' check (ui_language in ('en', 'id'));
