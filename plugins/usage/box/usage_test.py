"""Tests for usage.py's reading of Claude Code's `/usage`.

  python3 -m unittest plugins/usage/box/usage_test.py
"""
import datetime as dt
import importlib.util
import os
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("usage", pathlib.Path(__file__).with_name("usage.py"))
usage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(usage)

# What Claude Code 2.1.296 printed, word for word.
SAMPLE = """You are currently using your subscription to power your Claude Code usage

Current session: 31% used · resets Oct 15 at 3:30am (Asia/Saigon)
Current week (all models): 64% used · resets Oct 19 at 8am (Asia/Saigon)
Current week (Fable): 32% used · resets Oct 19 at 8am (Asia/Saigon)

What's contributing to your limits usage?
Last 24h · 318 requests · 5 sessions
  100% of your usage was at >150k context
"""

NOW = dt.datetime(2026, 10, 14, 12, 0, tzinfo=dt.timezone.utc)


def at(y, mo, d, h, mi, zone="Asia/Saigon"):
    from zoneinfo import ZoneInfo
    return int(dt.datetime(y, mo, d, h, mi, tzinfo=ZoneInfo(zone)).timestamp())


class ClaudeUsageTest(unittest.TestCase):
    def test_reads_the_session_the_week_and_a_models_week(self):
        l = usage.parse_claude_usage(SAMPLE, NOW)
        self.assertEqual(l["primary"], {"used_percent": 31.0, "window_minutes": 300, "resets_at": at(2026, 10, 15, 3, 30)})
        self.assertEqual(l["secondary"], {"used_percent": 64.0, "window_minutes": 10080, "resets_at": at(2026, 10, 19, 8, 0)})
        self.assertEqual(l["extra"], [{"used_percent": 32.0, "window_minutes": 10080, "resets_at": at(2026, 10, 19, 8, 0), "label": "Weekly limit (Fable)"}])

    def test_the_prose_below_is_no_limit(self):
        # "100% of your usage..." is about what drove the usage, not a window.
        l = usage.parse_claude_usage(SAMPLE, NOW)
        self.assertEqual(len(l["extra"]), 1)

    def test_no_session_line_means_no_reading(self):
        self.assertIsNone(usage.parse_claude_usage("Current week (all models): 4% used · resets Sep 14 at 5:59am (Asia/Jakarta)\n", NOW))
        self.assertIsNone(usage.parse_claude_usage("Usage is only available for subscription plans.\n", NOW))
        self.assertIsNone(usage.parse_claude_usage("", NOW))

    def test_a_reset_it_cannot_read_keeps_the_percentage(self):
        l = usage.parse_claude_usage("Current session: 38% used · resets in a little while\n", NOW)
        self.assertEqual(l["primary"]["used_percent"], 38.0)
        self.assertIsNone(l["primary"]["resets_at"])

    def test_resets_with_and_without_minutes(self):
        self.assertEqual(usage.reset_epoch("Sep 7 at 2:59pm (Asia/Jakarta)", dt.datetime(2026, 9, 7, tzinfo=dt.timezone.utc)), at(2026, 9, 7, 14, 59, "Asia/Jakarta"))
        self.assertEqual(usage.reset_epoch("Sep 7 at 3pm (Asia/Jakarta)", dt.datetime(2026, 9, 7, tzinfo=dt.timezone.utc)), at(2026, 9, 7, 15, 0, "Asia/Jakarta"))
        self.assertEqual(usage.reset_epoch("Sep 7 at 12am (Asia/Jakarta)", dt.datetime(2026, 9, 7, tzinfo=dt.timezone.utc)), at(2026, 9, 7, 0, 0, "Asia/Jakarta"))
        self.assertEqual(usage.reset_epoch("Sep 7 at 12pm (Asia/Jakarta)", dt.datetime(2026, 9, 7, tzinfo=dt.timezone.utc)), at(2026, 9, 7, 12, 0, "Asia/Jakarta"))

    def test_a_zone_with_am_in_its_name(self):
        self.assertEqual(usage.reset_epoch("Oct 19 at 8am (America/Panama)", NOW), at(2026, 10, 19, 8, 0, "America/Panama"))

    def test_the_year_nearest_now_across_new_year(self):
        eve = dt.datetime(2026, 12, 31, 12, tzinfo=dt.timezone.utc)
        self.assertEqual(usage.reset_epoch("Jan 2 at 9am (UTC)", eve), at(2027, 1, 2, 9, 0, "UTC"))
        new_year = dt.datetime(2027, 1, 2, 12, tzinfo=dt.timezone.utc)
        self.assertEqual(usage.reset_epoch("Dec 31 at 9am (UTC)", new_year), at(2026, 12, 31, 9, 0, "UTC"))

    def test_nonsense_is_none(self):
        self.assertIsNone(usage.reset_epoch("Smarch 3 at 9am (UTC)", NOW))
        self.assertIsNone(usage.reset_epoch("tomorrow", NOW))

    def test_off_reads_nothing(self):
        os.environ["BERTH_USAGE_CLAUDE_LIMITS"] = "0"
        try:
            self.assertEqual(usage.claude_limits(), [])
        finally:
            del os.environ["BERTH_USAGE_CLAUDE_LIMITS"]


if __name__ == "__main__":
    unittest.main()
