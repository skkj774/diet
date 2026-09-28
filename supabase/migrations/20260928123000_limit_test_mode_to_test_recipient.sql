update public.registrations
set test_mode = lower(trim(email)) = 'sk@taz-co.jp'
where test_mode is distinct from (lower(trim(email)) = 'sk@taz-co.jp');
