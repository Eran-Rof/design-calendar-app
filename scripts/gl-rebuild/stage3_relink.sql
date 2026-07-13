create index if not exists idx_ar_invoices_invnum on ar_invoices(invoice_number);
create index if not exists idx_invoices_invnum on invoices(invoice_number);

with ar_map as (
  select x.ref_number, (array_agg(je.id))[1] je_id
  from xoro_gl_transactions x
  join journal_entries je on je.source_id=x.txn_id and je.journal_type='xoro_gl_mirror'
  where x.txn_type_name='Invoice' and x.ref_number is not null
  group by x.ref_number
)
update ar_invoices ai set accrual_je_id=m.je_id from ar_map m where ai.invoice_number=m.ref_number;

with ap_map as (
  select x.ref_number, (array_agg(je.id))[1] je_id
  from xoro_gl_transactions x
  join journal_entries je on je.source_id=x.txn_id and je.journal_type='xoro_gl_mirror'
  where x.txn_type_name='Bill' and x.ref_number is not null
  group by x.ref_number
)
update invoices ap set accrual_je_id=m.je_id from ap_map m where ap.invoice_number=m.ref_number;

select jsonb_build_object(
  'ar_total',(select count(*) from ar_invoices),
  'ar_linked',(select count(*) from ar_invoices where accrual_je_id is not null),
  'ar_unmatched',(select count(*) from ar_invoices where accrual_je_id is null),
  'ap_total',(select count(*) from invoices),
  'ap_linked',(select count(*) from invoices where accrual_je_id is not null),
  'ap_unmatched',(select count(*) from invoices where accrual_je_id is null)
) as v;
