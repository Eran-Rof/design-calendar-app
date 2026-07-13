do $mig$
declare
  v_ms date := to_date('__YM__','YYYY-MM');
  v_me date := (to_date('__YM__','YYYY-MM') + interval '1 month')::date;
  v_8001 uuid := (select id from gl_accounts where entity_id=rof_entity_id() and code='8001');
begin
  alter table journal_entries disable trigger journal_entries_post_guard_ins;
  alter table journal_entries disable trigger journal_entries_pending_approval_ins;
  alter table journal_entries disable trigger je_period_lock_ins;
  alter table journal_entries disable trigger audit_row_changes;
  alter table journal_entry_lines disable trigger journal_entry_lines_immutable_trg;
  alter table journal_entry_lines disable trigger audit_row_changes;

  with legs as (
    select x.txn_id, x.row_seq, x.txn_date, x.txn_type_name tt, x.txn_number, x.ref_number,
           x.memo xmemo, x.accounting_name acctname,
           round(x.amount_home,2) amt, m.gl_account_id
    from xoro_gl_transactions x
    left join xoro_account_map m on m.xoro_accounting_name = coalesce(x.accounting_name,'')
    where x.txn_date >= v_ms and x.txn_date < v_me
  ),
  tx as (
    select txn_id, min(txn_date) txn_date, min(tt) tt, min(txn_number) txn_number, min(ref_number) ref_number,
           count(*) filter (where amt<>0) nz,
           count(*) filter (where amt<>0 and gl_account_id is null) unmapped_nz,
           round(sum(amt),2) net
    from legs group by txn_id
  ),
  post_tx as (
    select * from tx t
    where t.nz>=1 and t.unmapped_nz=0 and abs(t.net) <= 1.00
      and not exists (select 1 from journal_entries je
          where je.source_table='xoro_gl_mirror' and je.source_id=t.txn_id and je.basis='ACCRUAL')
  ),
  ins_je as (
    insert into journal_entries
      (entity_id, period_id, basis, journal_type, posting_date, source_module,
       source_table, source_id, description, status, posted_at)
    select rof_entity_id(), gl_find_period(rof_entity_id(), t.txn_date), 'ACCRUAL','xoro_gl_mirror',
           t.txn_date, lower(replace(coalesce(t.tt,'xoro_gl'),' ','_')),
           'xoro_gl_mirror', t.txn_id,
           left('Xoro GL mirror - '||coalesce(t.tt,'Txn')||' '||coalesce(t.ref_number,t.txn_number,'')||' ('||t.txn_date::text||')'
                || case when t.net<>0 then ' [rounding '||t.net::text||' to 8001]' else '' end, 400),
           'posted', now()
    from post_tx t
    returning id, source_id
  ),
  all_legs as (
    select l.txn_id, l.row_seq::bigint ord, l.gl_account_id acct, l.amt,
           left(coalesce(nullif(l.acctname,''),'(uncategorized)')
                || coalesce(' - '||nullif(l.xmemo,''),''), 240) memo
    from legs l join post_tx p on p.txn_id=l.txn_id where l.amt<>0
    union all
    select p.txn_id, 1000000000::bigint ord, v_8001, -p.net,
           'Penny rounding adjustment (Xoro sub-cent residual)'
    from post_tx p where p.net<>0
  )
  insert into journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, memo)
  select ij.id,
         (row_number() over (partition by al.txn_id order by al.ord))::smallint,
         al.acct,
         case when al.amt>0 then al.amt else 0 end,
         case when al.amt<0 then -al.amt else 0 end,
         al.memo
  from all_legs al join ins_je ij on ij.source_id = al.txn_id;

  alter table journal_entries enable trigger journal_entries_post_guard_ins;
  alter table journal_entries enable trigger journal_entries_pending_approval_ins;
  alter table journal_entries enable trigger je_period_lock_ins;
  alter table journal_entries enable trigger audit_row_changes;
  alter table journal_entry_lines enable trigger journal_entry_lines_immutable_trg;
  alter table journal_entry_lines enable trigger audit_row_changes;
end
$mig$;
select jsonb_build_object(
  'ym','__YM__',
  'posted_jes',(select count(*) from journal_entries where journal_type='xoro_gl_mirror'
      and posting_date>=to_date('__YM__','YYYY-MM') and posting_date<(to_date('__YM__','YYYY-MM')+interval '1 month')),
  'posted_lines',(select count(*) from journal_entry_lines l join journal_entries je on je.id=l.journal_entry_id
      where je.journal_type='xoro_gl_mirror'
      and je.posting_date>=to_date('__YM__','YYYY-MM') and je.posting_date<(to_date('__YM__','YYYY-MM')+interval '1 month'))
) as r;
