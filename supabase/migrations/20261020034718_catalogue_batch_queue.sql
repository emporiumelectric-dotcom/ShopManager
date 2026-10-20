-- Website project: dnmzzckeuctnkqbphwdg. Persist batch membership for retries.
alter table public.catalogue_imports add column if not exists batch_id uuid;
