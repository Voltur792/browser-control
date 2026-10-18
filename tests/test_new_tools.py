"""Behaviour of the tools that need extension 0.1.23+."""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src import bridge, plugin
from src.plugin import BrowserControl


class Recorder:
    def __init__(self, responses=None):
        self.calls = []
        self.responses = responses or {}

    async def __call__(self, action, payload):
        self.calls.append((action, payload))
        response = self.responses.get(action, {"ok": True, "message": "done"})
        return response(payload) if callable(response) else response


class NewToolsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for patch in (
            mock.patch.object(bridge, "data_dir", return_value=Path(directory.name)),
            mock.patch.object(bridge, "PORT", 0),
            mock.patch.object(plugin, "SETTINGS_FILE", Path(directory.name) / "settings.json"),
        ):
            patch.start()
            self.addCleanup(patch.stop)
        self.plugin = BrowserControl()
        self.addCleanup(self.plugin.bridge.stop)
        self.plugin.settings["mode"] = "extension"
        self.status = {"connected": True, "session": "s", "browser": "Google Chrome", "browser_code": "chrome", "extension_version": "1.0.0"}
        self.plugin.bridge.status = lambda: dict(self.status)
        self.plugin._tabs_session = "s"
        self.extension = Recorder()
        self.plugin._extension_action = self.extension

    def run_async(self, coroutine):
        return asyncio.run(coroutine)

    def test_old_extension_is_asked_to_update_instead_of_failing_obscurely(self):
        self.status["extension_version"] = None
        with self.assertRaisesRegex(RuntimeError, "обновить расширение"):
            self.run_async(self.plugin.browser_media_control("pause"))
        self.assertEqual(self.extension.calls, [])
        self.assertTrue(self.plugin._status()["extension_outdated"])

    def test_current_extension_is_not_flagged(self):
        self.assertFalse(self.plugin._status()["extension_outdated"])
        self.status["extension_version"] = "1.2.0"
        self.assertFalse(self.plugin._status()["extension_outdated"])

    def test_play_by_number_sends_title_from_shown_list(self):
        self.extension.responses["list_media"] = {"ok": True, "title": "YouTube", "url": "https://www.youtube.com", "items": [
            {"number": 1, "title": "Лофи для работы", "shorts": False},
            {"number": 2, "title": "Котики", "shorts": True},
        ]}
        listing = self.run_async(self.plugin.browser_list_media())
        self.assertTrue(listing.startswith("Вкладка «YouTube» (www.youtube.com):\n№1 — Лофи для работы\n№2 — Котики (Shorts)\n"))
        self.assertIn("ВМЕСТЕ с номерами", listing)
        self.run_async(self.plugin.browser_play_media(number=2))
        self.assertEqual(self.extension.calls[-1], ("play_media", {"query": "", "number": 2, "expected_title": "Котики"}))

    def test_window_number_uses_that_windows_active_tab_fresh(self):
        # The model last switched window 2 to VK, but the user has since opened YouTube there.
        self.extension.responses["list_tabs"] = {"ok": True, "tabs": [
            {"number": 1, "id": 11, "window": 1, "active": True, "title": "Кинопоиск"},
            {"number": 2, "id": 21, "window": 2, "active": False, "title": "ВКонтакте"},
            {"number": 3, "id": 22, "window": 2, "active": True, "title": "YouTube"},
        ]}
        self.extension.responses["list_media"] = {"ok": True, "title": "YouTube", "url": "https://www.youtube.com", "items": []}
        listing = self.run_async(self.plugin.browser_list_media(window_number=2))
        self.assertEqual(self.extension.calls[-1], ("list_media", {"chrome_tab_id": 22}))
        self.assertIn("«YouTube»", listing)
        with self.assertRaisesRegex(RuntimeError, "Окно 5 не найдено"):
            self.run_async(self.plugin.browser_list_media(window_number=5))

    def test_tab_and_window_mean_position_inside_that_window(self):
        # Real case: YouTube was "tab 32 in window 2" (global №43); №32 was Google Cloud Console.
        self.extension.responses["list_tabs"] = {"ok": True, "tabs": [
            {"number": 32, "id": 320, "window": 2, "tab_in_window": 21, "title": "Google Cloud console"},
            {"number": 43, "id": 430, "window": 2, "tab_in_window": 32, "title": "YouTube", "active": True},
        ]}
        self.extension.responses["list_media"] = {"ok": True, "title": "YouTube", "url": "https://www.youtube.com", "items": []}
        self.run_async(self.plugin.browser_list_media(tab_number=32, window_number=2))
        self.assertEqual(self.extension.calls[-1], ("list_media", {"chrome_tab_id": 430}))
        self.run_async(self.plugin.browser_list_media(tab_number=32))
        self.assertEqual(self.extension.calls[-1], ("list_media", {"chrome_tab_id": 320}))
        with self.assertRaisesRegex(RuntimeError, "В окне 2 нет вкладки 99"):
            self.run_async(self.plugin.browser_list_media(tab_number=99, window_number=2))

    def test_audio_answer_is_readable_and_names_the_mute_call(self):
        self.extension.responses["list_tabs"] = {"ok": True, "tabs": [
            {"number": 11, "id": 5, "window": 1, "tab_in_window": 11, "title": "Звёздные врата", "url": "https://stargate.example", "audible": True},
        ]}
        answer = self.run_async(self.plugin.browser_find_audio_tabs())
        self.assertIn("№11: «Звёздные врата» — stargate.example", answer)
        self.assertIn('action="mute"', answer)
        self.run_async(self.plugin.browser_find_audio_tabs(action="mute"))
        self.assertEqual(self.extension.calls[-1], ("media_control", {"command": "mute"}))
        # Unmute and feed scrolling work even when nothing is audible right now.
        self.extension.responses["list_tabs"] = {"ok": True, "tabs": []}
        for command in ("unmute", "next", "previous", "play"):
            self.run_async(self.plugin.browser_find_audio_tabs(action=command))
            self.assertEqual(self.extension.calls[-1], ("media_control", {"command": command}))

    def test_quick_actions_for_commands_without_ai(self):
        for method, command in (("browser_quick_next", "next"), ("browser_quick_previous", "previous"),
                                ("browser_quick_mute", "mute"), ("browser_quick_unmute", "unmute")):
            self.run_async(self.plugin.execute_action(method, "{}"))
            self.assertEqual(self.extension.calls[-1], ("media_control", {"command": command}))

    def test_null_and_string_numbers_from_the_model_are_accepted(self):
        self.extension.responses["list_tabs"] = {"ok": True, "tabs": [
            {"number": 2, "id": 20, "window": 1, "tab_in_window": 2, "title": "YouTube"},
        ]}
        self.extension.responses["list_media"] = {"ok": True, "title": "YouTube", "url": "https://www.youtube.com", "items": []}
        answer = self.run_async(self.plugin.call_tool("browser_list_media", '{"tab_number": null}'))
        self.assertTrue(answer["success"])
        self.assertEqual(self.extension.calls[-1], ("list_media", {}))
        self.run_async(self.plugin.call_tool("browser_list_media", '{"tab_number": "2", "window_number": 1.0}'))
        self.assertEqual(self.extension.calls[-1], ("list_media", {"chrome_tab_id": 20}))

    def test_blocked_page_error_is_explained(self):
        self.plugin._extension_action = BrowserControl._extension_action.__get__(self.plugin)
        with mock.patch.object(self.plugin.bridge, "request", create=True, return_value={
            "ok": False, "error": "Error: Cannot access contents of the page. Extension manifest must request permission to access the respective host."
        }):
            with self.assertRaisesRegex(RuntimeError, "не даёт расширениям доступ"):
                self.run_async(self.plugin.browser_read_page())

    def test_no_audio_answer_points_to_media_list(self):
        self.extension.responses["list_tabs"] = {"ok": True, "tabs": []}
        self.assertIn("browser_list_media", self.run_async(self.plugin.browser_find_audio_tabs()))

    def test_play_by_number_goes_to_the_listed_tab_once(self):
        self.extension.responses["list_media"] = {"ok": True, "tab_id": 777, "title": "YouTube", "url": "https://www.youtube.com", "items": [
            {"number": n, "title": f"Видео {n}", "shorts": False} for n in range(1, 11)
        ]}
        self.run_async(self.plugin.browser_list_media())
        self.run_async(self.plugin.browser_play_media(number=10))
        action, payload = self.extension.calls[-1]
        self.assertEqual((action, payload["chrome_tab_id"], payload["number"]), ("play_media", 777, 10))
        # A model looping over "play 1..10" is stopped after the first video.
        with self.assertRaisesRegex(RuntimeError, "одновременно включается одно видео"):
            self.run_async(self.plugin.browser_play_media(number=9))

    def test_play_by_number_without_list_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "список видео"):
            self.run_async(self.plugin.browser_play_media(number=1))

    def test_read_page_reports_parts(self):
        self.extension.responses["read_page"] = lambda payload: {"ok": True, "text": "x", "total_length": 40000, "offset": payload["offset"]}
        self.assertTrue(self.run_async(self.plugin.browser_read_page()).endswith("[Часть 1 из 3; продолжение — part=2]"))
        self.assertEqual(self.extension.calls[-1][1], {"offset": 0})
        self.assertTrue(self.run_async(self.plugin.browser_read_page(3)).endswith("[Часть 3 из 3, конец страницы]"))
        self.assertEqual(self.extension.calls[-1][1], {"offset": 30000})

    def test_youtube_in_simple_mode_opens_search(self):
        self.plugin.settings["mode"] = "simple"
        with mock.patch.object(plugin, "_open_basic") as opened:
            message = self.run_async(self.plugin.browser_youtube_play("лофи для работы"))
        opened.assert_called_once_with("https://www.youtube.com/results?search_query=%D0%BB%D0%BE%D1%84%D0%B8+%D0%B4%D0%BB%D1%8F+%D1%80%D0%B0%D0%B1%D0%BE%D1%82%D1%8B", "default")
        self.assertIn("режиме с расширением", message)

    def test_close_others_forgets_tab_numbers(self):
        self.plugin._tabs = {1: {"number": 1, "id": 7}}
        self.run_async(self.plugin.browser_tab_action("close_others"))
        self.assertEqual(self.plugin._tabs, {})

    def test_search_engine_setting_is_saved_and_used(self):
        result = self.plugin.ui_set_settings(mode="simple", browser="default", search="duckduckgo")
        self.assertTrue(result["ok"])
        self.assertEqual(json.loads(plugin.SETTINGS_FILE.read_text(encoding="utf-8"))["search"], "duckduckgo")
        self.assertEqual(plugin._load_settings()["search"], "duckduckgo")
        with mock.patch.object(plugin, "_open_basic", return_value="ok") as opened:
            self.run_async(self.plugin.browser_search("погода"))
        opened.assert_called_once_with("https://duckduckgo.com/?q=%D0%BF%D0%BE%D0%B3%D0%BE%D0%B4%D0%B0", "default")
        self.assertFalse(self.plugin.ui_set_settings(search="altavista")["ok"])

    def test_settings_without_search_keep_old_choice(self):
        self.plugin.ui_set_settings(mode="simple", browser="default", search="bing")
        self.plugin.ui_set_settings(mode="extension", browser="chrome")
        self.assertEqual(self.plugin.settings["search"], "bing")


if __name__ == "__main__":
    unittest.main()
