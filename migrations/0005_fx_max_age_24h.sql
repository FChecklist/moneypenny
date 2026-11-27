-- The exchange rate may be at most 24 hours old (was 72). A tenant that still holds the old default is moved; any other value is kept.
UPDATE tenant_setting SET value = '24' WHERE key = 'fx_max_age_hours' AND value = '72';
