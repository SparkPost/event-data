CREATE OR REPLACE FUNCTION public.trigger_month_auto_partitioner(
) RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_ts timestamp := to_timestamp(NEW."timestamp") at time zone 'GMT';
  v_trunc timestamp;
  v_month int := date_part('month', v_ts)::int;
  v_date text := date_part('year', v_ts) || lpad(v_month::text, 2, '0');
  v_fqtn text; -- fully-qualified table name
  v_fqpn text; -- fully-qualified partition name
  v_sql text;
  v_dupe boolean := false;
BEGIN
  -- Sanity check args passed from "CREATE TRIGGER": (schema, table, function)
  -- "function" is in a partition init callback, ignored if blank
  IF TG_OP != 'INSERT' THEN
    RAISE EXCEPTION 'trigger_month_auto_partitioner only handles ''INSERT''s, not %', TG_OP;
  ELSIF TG_NARGS != 3 THEN
    RAISE EXCEPTION 'trigger_month_auto_partitioner expects 3 arguments (schema, table, function), saw %', TG_NARGS;
  ELSIF v_ts IS NULL THEN
    RAISE EXCEPTION 'trigger_month_auto_partitioner "timestamp" column may not be null';
  END IF;

  -- Don't set these until after sanity checking to avoid asplosions.
  v_fqtn := TG_ARGV[0] ||'.'|| TG_ARGV[1];
  v_fqpn := v_fqtn ||'_'|| v_date;

  -- Auto-create partition if it's not there already.
  -- IF true THEN -- DEBUG: always attempt table creation
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
      WHERE schemaname = TG_ARGV[0]
        AND tablename = TG_ARGV[1] ||'_'|| v_date
  ) THEN
    RAISE NOTICE 'trigger_month_auto_partitioner creating: %', v_fqpn;
    -- Inherit from parent table to define columns.
    -- Set check constraints to enable partition exclusion based on date range.
    v_trunc := date_trunc('month', v_ts);
    v_sql := '
      CREATE TABLE '|| v_fqpn ||' (
        CHECK ( to_timestamp("timestamp") at time zone ''GMT'' >= '|| quote_literal(v_trunc::date) ||
        ' AND   to_timestamp("timestamp") at time zone ''GMT'' < '|| quote_literal((v_trunc + interval '1 month')::date) ||')
    ) INHERITS ('|| v_fqtn ||')';
    BEGIN
      -- PERFORM pg_sleep_for('2 seconds'); -- DEBUG: make this take longer so two calls can get in here
      /*
       * Exclusive transaction lock around per-month table creation,
       * so we can't race ahead to insert before create & init is done.
       * First arg is arbitrary, effectively a lock namespace.
       * Second arg represents the specific thing we're locking, month in this case.
       * Inserts are allowed into existing partitions while new partitions are created.
       */
      PERFORM pg_advisory_xact_lock(42, v_month);
      BEGIN
        EXECUTE v_sql;
      EXCEPTION WHEN duplicate_table THEN
        -- handle race for table creation
        RAISE NOTICE 'trigger_month_auth_partitioner ignoring duplicate_table 42P07';
        v_dupe := true;
      END;

      -- if this call created the table, and an init function was configured, do the init
      IF false = v_dupe THEN
        IF coalesce(ltrim(rtrim(TG_ARGV[2])), '') != '' THEN
          -- call init function, if defined in the "CREATE TRIGGER" statement
          RAISE NOTICE 'trigger_month_auto_partitioner initializing %', v_fqpn;
          v_sql := 'SELECT '|| TG_ARGV[0] ||'.'|| TG_ARGV[2] ||'('|| quote_literal(v_fqpn) ||')';
          EXECUTE v_sql;
        END IF;
      END IF;
    END;
  END IF;

  /*
   * Shared transaction lock around row insertion for the current month,
   * so inserts to that partition will wait until after init has finished.
   */
  PERFORM pg_advisory_xact_lock_shared(42, v_month);
  v_sql := 'INSERT INTO '|| v_fqpn ||' VALUES ($1.*)';
  EXECUTE v_sql USING NEW;

  RETURN NULL;
END;
$$;

-- TODO: reinitialize all partitions
-- TODO: assert that all partitions have the correct info

CREATE OR REPLACE FUNCTION public.init_events_partition (
  p_fqtn text
) RETURNS void LANGUAGE plpgsql STRICT AS $$
DECLARE
  v_sql text;
BEGIN
  -- initialize new partition, creating indexes etc
END;
$$;

CREATE TRIGGER trigger_events
  BEFORE INSERT ON public.events
  FOR EACH ROW EXECUTE PROCEDURE public.trigger_month_auto_partitioner('public', 'events', 'init_events_partition');

/*
CREATE OR REPLACE FUNCTION public.init_month_auto_partitioned (
  p_fqtn text
) RETURNS void LANGUAGE plpgsql STRICT AS $$
DECLARE
  v_sql text;
BEGIN
  -- indexes
  RAISE NOTICE 'TODO: create indexes on new partition';
END;
$$;

DROP TABLE IF EXISTS public.month_auto_partitioned CASCADE;
CREATE TABLE public.month_auto_partitioned (
  dap_id bigserial primary key,
  value text,
  "timestamp" double precision
);

CREATE TRIGGER trigger_month_auto_partitioned
  BEFORE INSERT ON public.month_auto_partitioned
  FOR EACH ROW EXECUTE PROCEDURE
    public.trigger_month_auto_partitioner('public', 'month_auto_partitioned', 'init_month_auto_partitioned');

INSERT INTO public.month_auto_partitioned (value, "timestamp") VALUES ('fooo', date_part('epoch', now()));
INSERT INTO public.month_auto_partitioned (value, "timestamp") VALUES ('barr', date_part('epoch', now()));
*/
