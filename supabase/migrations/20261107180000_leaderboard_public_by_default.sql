-- New profiles join the public leaderboard by default.
-- Existing profiles keep their current leaderboard_visible value; users can
-- still turn visibility off at any time from the Leaderboard page.

alter table public.profiles
  alter column leaderboard_visible set default true;
