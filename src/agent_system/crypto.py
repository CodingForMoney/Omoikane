from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken


class StateCipher:
    def __init__(self, secret: str):
        key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode("utf-8")).digest())
        self._fernet = Fernet(key)

    def encrypt(self, plaintext: bytes) -> tuple[bytes, str]:
        checksum = hashlib.sha256(plaintext).hexdigest()
        return self._fernet.encrypt(plaintext), checksum

    def decrypt(self, ciphertext: bytes, expected_checksum: str) -> bytes:
        try:
            plaintext = self._fernet.decrypt(ciphertext)
        except InvalidToken as exc:
            raise ValueError("run state authentication failed") from exc
        actual = hashlib.sha256(plaintext).hexdigest()
        if actual != expected_checksum:
            raise ValueError("run state checksum mismatch")
        return plaintext
