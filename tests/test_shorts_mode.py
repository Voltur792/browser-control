"""Hands-free shorts mode: phrase matching and plugin wiring (no microphone)."""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src import bridge, plugin, shorts_mode
from src.plugin import BrowserControl
from src.shorts_mode import match_command


def result(text, conf=0.95):
    words = [{"word": word, "conf": conf} for word in text.split()]
    return json.dumps({"text": text, "result": words}, ensure_ascii=False)


class MatchCommandTests(unittest.TestCase):
    def test_short_words_map_to_commands(self):
        self.assertEqual(match_command(result("дальше")), "next")
        self.assertEqual(match_command(result("назад")), "previous")
        self.assertEqual(match_command(result("пауза")), "pause")
        self.assertEqual(match_command(result("продолжи")), "play")
        self.assertEqual(match_command(result("выключи звук")), "mute")
        self.assertEqual(match_command(result("включи звук")), "unmute")
        self.assertEqual(match_command(result("закончить просмотр")), "stop_mode")

    def test_yo_and_case_do_not_matter(self):
        self.assertEqual(match_command(result("Вперёд")), "next")
        self.assertEqual(match_command(result("вперед")), "next")

    def test_phrase_inside_other_speech_is_ignored(self):
        # Video audio or a longer sentence arrives with [unk] around the word.
        self.assertIsNone(match_command(result("[unk] дальше [unk]")))
        self.assertIsNone(match_command(result("дальше назад")))
        self.assertIsNone(match_command(result("[unk]")))
        self.assertIsNone(match_command(result("")))
        self.assertIsNone(match_command("not json"))

    def test_every_phrase_variant_maps_back(self):
        for command, phrases in shorts_mode.PHRASES.items():
            for phrase in phrases:
                self.assertEqual(match_command(result(phrase)), command, phrase)

    def test_low_confidence_is_ignored(self):
        self.assertIsNone(match_command(result("дальше", conf=0.3)))

    def test_grammar_lists_every_phrase(self):
        words = json.loads(shorts_mode.grammar())
        self.assertIn("[unk]", words)
        self.assertIn("закончить просмотр", words)


class ShortsPluginTests(unittest.TestCase):
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
        self.plugin.bridge.status = lambda: {"connected": True, "session": "s", "extension_version": "1.0.0"}
        self.started = []
        self.plugin.shorts.start = lambda: self.started.append(True) or True
        self.plugin.shorts.stop = mock.Mock(return_value=True)

    def test_tool_and_actions_toggle_the_mode(self):
        message = asyncio.run(self.plugin.browser_shorts_mode(True))
        self.assertIn("«дальше»", message)
        self.assertEqual(self.started, [True])
        asyncio.run(self.plugin.execute_action("browser_quick_shorts_off", "{}"))
        self.plugin.shorts.stop.assert_called_once()
        asyncio.run(self.plugin.execute_action("browser_quick_shorts_on", "{}"))
        self.assertEqual(len(self.started), 2)

    def test_recognized_word_is_sent_to_the_extension(self):
        with mock.patch.object(self.plugin.bridge, "request", create=True, return_value={"ok": True}) as request:
            self.plugin._shorts_command("next")
        request.assert_called_once_with("media_control", {"command": "next"}, 10)

    def test_outdated_extension_is_reported(self):
        self.plugin.bridge.status = lambda: {"connected": True, "session": "s", "extension_version": "0.1.10"}
        with self.assertRaisesRegex(RuntimeError, "обновите расширение"):
            self.plugin._shorts_command("next")

    def test_status_reports_mode_for_the_ui(self):
        status = self.plugin._status()["shorts_mode"]
        self.assertEqual(status["state"], "off")
        self.assertIn("дальше", status["phrases"]["next"])


if __name__ == "__main__":
    unittest.main()
