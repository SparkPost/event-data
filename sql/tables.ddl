CREATE TABLE public.batches (
  batch_uuid  uuid primary key,
  loaded_at   timestamptz not null default clock_timestamp()
);

CREATE TABLE public.events (
  event_id bigint not null,
  "timestamp" double precision not null,
  type text not null,

  bounce_class int null,
  campaign_id text null,
  friendly_from text null,
  message_id text null,
  reason text null,
  rcpt_to text null,
  subaccount_id int null,
  template_id text null,
  transmission_id bigint null,

  event jsonb null
);

