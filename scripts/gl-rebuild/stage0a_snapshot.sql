-- STAGE 0a: reversible snapshot (idempotent: IF NOT EXISTS skips re-capture, never clobbers).
create table if not exists je_backup_20260713 as select * from journal_entries;
create table if not exists jel_backup_20260713 as select * from journal_entry_lines;
create table if not exists tb_before_rebuild as
  select a.id as account_id, a.code, a.name, a.account_type,
         coalesce(sum(l.debit),0) as debit, coalesce(sum(l.credit),0) as credit,
         coalesce(sum(l.debit),0) - coalesce(sum(l.credit),0) as net_debit
  from gl_accounts a
  left join journal_entry_lines l on l.account_id = a.id
  left join journal_entries je on je.id = l.journal_entry_id and je.status='posted'
  where a.entity_id = rof_entity_id()
  group by a.id, a.code, a.name, a.account_type;
select jsonb_build_object(
  'je_backup_rows', (select count(*) from je_backup_20260713),
  'jel_backup_rows', (select count(*) from jel_backup_20260713),
  'tb_before_rows', (select count(*) from tb_before_rebuild),
  'live_je_rows', (select count(*) from journal_entries),
  'live_jel_rows', (select count(*) from journal_entry_lines),
  'tb_imbalance', (select coalesce(sum(net_debit),0) from tb_before_rebuild)
) as snapshot;
