-- Apply after incremental.sql and after merging existing duplicate names.
-- Inactive payment methods also reserve their names within the same account.
alter table savin.payments add constraint payments_user_name_key unique (user_id, name);
