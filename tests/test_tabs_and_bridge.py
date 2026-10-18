"""Regressions for tab-number races and bridge startup on a busy port."""

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src import bridge
from src.plugin import BrowserControl


def _tab(number, tab_id, window=1):
    return {"number": number, "id": tab_id, "window": window, "tab_in_window": number, "title": f"Tab {number}", "url": ""}


class FakeExtension:
    def __init__(self, tabs):
        self.tabs = tabs
        self.calls = []

    async def __call__(self, action, payload):
        self.calls.append((action, payload))
        if action == "list_tabs":
            return {"ok": True, "tabs": list(self.tabs)}
        return {"ok": True, "message": "done"}


class TabSnapshotTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        patches = [
            mock.patch.object(bridge, "data_dir", return_value=Path(directory.name)),
            mock.patch.object(bridge, "PORT", 0),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.plugin = BrowserControl()
        self.addCleanup(self.plugin.bridge.stop)
        self.session = "session-1"
        self.plugin.bridge.status = lambda: {"connected": True, "session": self.session}
        self.plugin._tabs_session = self.session
        self.extension = FakeExtension([_tab(1, 101), _tab(2, 102), _tab(3, 103, window=2)])
        self.plugin._extension_action = self.extension

    def run_async(self, coroutine):
        return asyncio.run(coroutine)

    def test_close_uses_ids_from_the_list_the_user_saw(self):
        self.run_async(self.plugin.browser_list_tabs())
        # Tab 1 closes elsewhere; positions shift, but "tab 3" must still mean id 103.
        self.extension.tabs = [_tab(1, 102), _tab(2, 103, window=2)]
        self.run_async(self.plugin.browser_close_tabs([3]))
        action, payload = self.extension.calls[-1]
        self.assertEqual(action, "close_tabs")
        self.assertEqual(payload["chrome_tab_ids"], [103])

    def test_closed_number_is_not_reused_for_another_tab(self):
        self.run_async(self.plugin.browser_list_tabs())
        self.run_async(self.plugin.browser_close_tabs([2]))
        calls = len(self.extension.calls)
        with self.assertRaisesRegex(RuntimeError, "нет в последнем списке"):
            self.run_async(self.plugin.browser_close_tabs([2]))
        self.assertEqual(len(self.extension.calls), calls)

    def test_window_check_aborts_whole_close(self):
        self.run_async(self.plugin.browser_list_tabs())
        with self.assertRaisesRegex(RuntimeError, "не в окне 2"):
            self.run_async(self.plugin.browser_close_tabs([1, 3], window_number=2))
        self.assertNotIn("close_tabs", [action for action, _ in self.extension.calls])

    def test_new_browser_session_takes_a_fresh_list(self):
        self.run_async(self.plugin.browser_list_tabs())
        self.session = "session-2"
        self.extension.tabs = [_tab(1, 501)]
        self.run_async(self.plugin.browser_activate_tab(1))
        self.assertEqual(self.extension.calls[-2][0], "list_tabs")
        self.assertEqual(self.extension.calls[-1][1]["chrome_tab_id"], 501)


class BridgePortTests(unittest.TestCase):
    def test_second_bridge_on_busy_port_fails_without_stealing_it(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(bridge, "data_dir", return_value=Path(directory)):
            with mock.patch.object(bridge, "PORT", 0):
                first = bridge.BrowserBridge()
                first.start()
            self.addCleanup(first.stop)
            with mock.patch.object(bridge, "PORT", first.port):
                second = bridge.BrowserBridge()
                with self.assertRaises(OSError):
                    second.start()
                self.assertFalse(second.running)

    def test_plugin_survives_busy_port_and_reports_it(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(bridge, "data_dir", return_value=Path(directory)):
            with mock.patch.object(bridge, "PORT", 0):
                first = bridge.BrowserBridge()
                first.start()
            self.addCleanup(first.stop)
            with mock.patch.object(bridge, "PORT", first.port):
                plugin = BrowserControl()
                self.assertIn("порт", plugin._status()["bridge_error"])
                with self.assertRaisesRegex(RuntimeError, "порт"):
                    plugin._require_connected_browser()


if __name__ == "__main__":
    unittest.main()
