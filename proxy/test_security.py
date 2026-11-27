import unittest
from unittest.mock import patch

from server import _validate_public_url


class _FakeLoop:
    async def getaddrinfo(self, host, port, type):
        return [
            (2, 1, 6, "", ("8.8.8.8", port)),
            (2, 1, 6, "", ("192.168.1.10", port)),
        ]


class ProxyTargetValidationTests(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_loopback_ipv4(self):
        with self.assertRaises(ValueError):
            await _validate_public_url("http://127.0.0.1:8000/")

    async def test_rejects_private_ipv4(self):
        with self.assertRaises(ValueError):
            await _validate_public_url("http://192.168.1.10/")

    async def test_rejects_loopback_ipv6(self):
        with self.assertRaises(ValueError):
            await _validate_public_url("http://[::1]/")

    async def test_accepts_public_ipv4(self):
        self.assertEqual(
            await _validate_public_url("https://8.8.8.8/video.m3u8"),
            "https://8.8.8.8/video.m3u8",
        )

    async def test_rejects_non_http_scheme(self):
        with self.assertRaises(ValueError):
            await _validate_public_url("file:///etc/passwd")

    async def test_rejects_embedded_credentials(self):
        with self.assertRaises(ValueError):
            await _validate_public_url("https://user:password@example.com/video")

    async def test_rejects_hostname_with_any_private_dns_answer(self):
        with patch("server.asyncio.get_running_loop", return_value=_FakeLoop()):
            with self.assertRaises(ValueError):
                await _validate_public_url("https://media.example/video.m3u8")


if __name__ == "__main__":
    unittest.main()
