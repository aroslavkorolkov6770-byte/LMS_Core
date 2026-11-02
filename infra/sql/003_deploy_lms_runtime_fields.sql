alter table deploy_profiles
  add column if not exists lms_source_path text,
  add column if not exists deployment_bundle_path text,
  add column if not exists alice_tenant_code text,
  add column if not exists alice_model_preset text,
  add column if not exists preview_theme_primary text,
  add column if not exists preview_theme_accent text,
  add column if not exists preview_theme_background text,
  add column if not exists preview_theme_surface text;
