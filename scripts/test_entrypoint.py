"""Check file-backed credentials without starting OpenCode or contacting providers."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class EntrypointTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("OPENCODE_", "GOOGLE_GENERATIVE_AI_API_KEY"))}
        self.env.update(HOME=str(self.home), XDG_CONFIG_HOME=str(self.home / "config"),
                        XDG_DATA_HOME=str(self.home / "data"),
                        XDG_STATE_HOME=str(self.home / "state"),
                        XDG_CACHE_HOME=str(self.home / "cache"))
        self.password = self.home / "password"
        self.password.write_text("a" * 64 + "\n")
        self.key = self.home / "key"
        self.key.write_text("test-gemini-key\n")

    def run_entrypoint(self, **env):
        return subprocess.run(
            ["sh", str(Path(__file__).resolve().parents[1] / "entrypoint.sh"),
             "sh", "-c", 'test "${#OPENCODE_SERVER_PASSWORD}" -eq 64 && '
             'test "${GOOGLE_GENERATIVE_AI_API_KEY:-}" = "test-gemini-key"'],
            env={**self.env, **env}, capture_output=True, text=True,
        )

    def test_files_are_loaded_and_exported(self):
        result = self.run_entrypoint(OPENCODE_SERVER_PASSWORD_FILE=str(self.password),
                                     GOOGLE_GENERATIVE_AI_API_KEY_FILE=str(self.key))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout + result.stderr, "")

    def test_environment_credentials_still_work(self):
        result = self.run_entrypoint(OPENCODE_SERVER_PASSWORD="a" * 64,
                                     GOOGLE_GENERATIVE_AI_API_KEY="test-gemini-key")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_ambiguous_or_missing_files_fail(self):
        for fields in [
            {"OPENCODE_SERVER_PASSWORD_FILE": str(self.home / "missing")},
            {"OPENCODE_SERVER_PASSWORD_FILE": str(self.password),
             "OPENCODE_SERVER_PASSWORD": "b" * 64},
            {"OPENCODE_SERVER_PASSWORD": "a" * 64,
             "GOOGLE_GENERATIVE_AI_API_KEY_FILE": str(self.key),
             "GOOGLE_GENERATIVE_AI_API_KEY": "conflicting-key"},
        ]:
            with self.subTest(fields=list(fields)):
                result = self.run_entrypoint(**fields)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("a" * 64, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
