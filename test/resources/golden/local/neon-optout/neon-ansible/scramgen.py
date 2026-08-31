#!/usr/bin/env python3
"""Print a PostgreSQL SCRAM-SHA-256 verifier for the password on stdin.

The compute spec's `roles[].encrypted_password` accepts this verifier form
directly (verified against the pinned compute image), so the plaintext lives
only in its 0600 secret file and the spec carries the salted verifier. The
password arrives on stdin, never argv, so it cannot surface in a process
listing."""
import base64
import hashlib
import hmac
import os
import sys

password = sys.stdin.readline().rstrip("\n")
if not password:
    sys.exit("scramgen: empty password on stdin")
salt = os.urandom(16)
iterations = 4096
salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
stored_key = hashlib.sha256(client_key).digest()
server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
print("SCRAM-SHA-256$%d:%s$%s:%s" % (
    iterations,
    base64.b64encode(salt).decode(),
    base64.b64encode(stored_key).decode(),
    base64.b64encode(server_key).decode(),
))
