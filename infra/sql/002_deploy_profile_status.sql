alter table deploy_profiles
  add column if not exists status text;

update deploy_profiles
set status = 'draft'
where status is null;

alter table deploy_profiles
  alter column status set default 'draft';
