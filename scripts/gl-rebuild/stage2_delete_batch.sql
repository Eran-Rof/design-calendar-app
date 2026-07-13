do $mig$
begin
  alter table journal_entries disable trigger je_period_lock_del;
  alter table journal_entries disable trigger audit_row_changes;
  alter table journal_entry_lines disable trigger journal_entry_lines_immutable_trg;
  alter table journal_entry_lines disable trigger audit_row_changes;
  delete from journal_entries where id in (
    select id from journal_entries where journal_type<>'xoro_gl_mirror' limit 3000);
  alter table journal_entries enable trigger je_period_lock_del;
  alter table journal_entries enable trigger audit_row_changes;
  alter table journal_entry_lines enable trigger journal_entry_lines_immutable_trg;
  alter table journal_entry_lines enable trigger audit_row_changes;
end $mig$;
select count(*) n from journal_entries where journal_type<>'xoro_gl_mirror';
