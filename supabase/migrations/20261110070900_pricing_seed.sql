-- Legiit Recommends — global default model prices (version 1).
--
-- Standard-tier prices in USD per 1M tokens, read from the official OpenAI pricing page on
-- 2026-11-10: https://developers.openai.com/api/docs/pricing
--
-- These rows are reference data, not campaign data. They are global (workspace_id NULL), can
-- only be changed by a migration, and are superseded per workspace by anything an owner enters
-- under Settings → Model pricing. Prices change: owners should re-verify before relying on
-- estimates. Cost figures in the app are usage-based estimates, never invoices.
--
-- Columns on the pricing page: input, output, cached input, 30-minute cache write, 12-hour
-- cache write. "Long context" (> 272K input tokens) is priced at 2x input-side rates and 1.5x
-- output for the whole request on the models that list it.

insert into public.model_prices (
  workspace_id, model_id, version,
  input_usd_per_mtok, cached_input_usd_per_mtok, output_usd_per_mtok,
  cache_write_30m_usd_per_mtok, cache_write_12h_usd_per_mtok,
  long_context_threshold_tokens, long_context_input_multiplier, long_context_output_multiplier,
  source_url, verified_on, notes
)
select
  null, v.model_id, 1,
  v.input, v.cached, v.output, v.cw30, v.cw12,
  case when v.long_context then 272000 end,
  case when v.long_context then 2 end,
  case when v.long_context then 1.5 end,
  'https://developers.openai.com/api/docs/pricing', date '2026-11-10', v.notes
from (
  values
    ('gpt-6-astra',   10.00, 1.00,   50.00, 12.50, 25.00, true,  null),
    ('gpt-6.1-sol',    2.00, 0.10,   10.00,  2.50,  5.00, true,  null),
    ('gpt-6.1-terra',  1.00, 0.05,    5.00,  1.25,  2.50, true,  null),
    ('gpt-6-luna',     0.10, 0.01,    0.50,  0.125, 0.25, true,  null),
    ('gpt-6-sol',      2.00, 0.20,   10.00,  2.50,  5.00, true,  null),
    ('gpt-5.6-sol',    4.00, 0.40,   20.00,  5.00, 10.00, true,
       'Listed as a limited-time rate when verified. Re-verify after 2026-11-30.'),
    ('gpt-5.6-terra',  2.00, 0.20,   12.00,  2.50,  5.00, true,  null),
    ('gpt-5.6-luna',   0.20, 0.02,    1.20,  0.25,  0.50, true,  null),
    ('gpt-5.5',        5.00, 0.50,   30.00,  null,  null, true,  null),
    ('gpt-5.5-pro',   30.00, null,  180.00,  null,  null, true,  null),
    ('gpt-5.4',        2.50, 0.25,   15.00,  null,  null, true,  null),
    ('gpt-5.4-pro',   30.00, null,  180.00,  null,  null, true,  null),
    ('gpt-5.4-mini',   0.75, 0.075,   4.50,  null,  null, false, null),
    ('gpt-5.4-nano',   0.20, 0.02,    1.25,  null,  null, false, null),
    ('gpt-5.2',        1.75, 0.175,  14.00,  null,  null, false, null),
    ('gpt-5.2-pro',   21.00, null,  168.00,  null,  null, false, null),
    ('gpt-5.1',        1.25, 0.125,  10.00,  null,  null, false, null),
    ('gpt-5',          1.25, 0.125,  10.00,  null,  null, false, null),
    ('gpt-5-mini',     0.25, 0.025,   2.00,  null,  null, false, null),
    ('gpt-5-nano',     0.05, 0.005,   0.40,  null,  null, false, null),
    ('gpt-5-pro',     15.00, null,  120.00,  null,  null, false, null),
    ('gpt-4.1',        2.00, 0.50,    8.00,  null,  null, false, null),
    ('gpt-4.1-mini',   0.40, 0.10,    1.60,  null,  null, false, null),
    ('gpt-4o',         2.50, 1.25,   10.00,  null,  null, false, null),
    ('gpt-4o-mini',    0.15, 0.075,   0.60,  null,  null, false, null),
    ('o3',             2.00, 0.50,    8.00,  null,  null, false, null),
    ('o3-pro',        20.00, null,   80.00,  null,  null, false, null)
) as v(model_id, input, cached, output, cw30, cw12, long_context, notes)
on conflict do nothing;
