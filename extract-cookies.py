#!/usr/bin/env python3
"""
Disboard Session Cookie Extractor (Linux)
Extracts and decrypts active session cookies from Chromium-based browsers (Brave, Google Chrome, Chromium).
"""

import sqlite3
import os
import sys
import tempfile
import shutil
import json
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

def get_browser_key(browser_name):
    """Retrieve encryption key from SecretStorage / Keyring if available."""
    try:
        import secretstorage
        bus = secretstorage.dbus_init()
        collection = secretstorage.get_default_collection(bus)
        for item in collection.get_all_items():
            label = item.get_label().lower()
            if browser_name.lower() in label and 'safe storage' in label:
                return item.get_secret()
    except Exception:
        pass
    return b'peanuts'

def get_cookies_from_path(browser_name, cookie_path):
    expanded_path = os.path.expanduser(cookie_path)
    if not os.path.exists(expanded_path):
        return []

    password = get_browser_key(browser_name)
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA1(),
        length=16,
        salt=b'saltysalt',
        iterations=1,
    )
    key = kdf.derive(password)
    iv = b' ' * 16

    tmp = tempfile.mktemp(suffix='.db')
    try:
        shutil.copy2(expanded_path, tmp)
    except Exception:
        return []

    cookies = []
    try:
        conn = sqlite3.connect(tmp)
        c = conn.cursor()
        c.execute("""
            SELECT name, encrypted_value, value, host_key, path, is_secure, is_httponly, samesite, expires_utc 
            FROM cookies WHERE host_key LIKE '%disboard%'
        """)
        for name, enc_val, val, host, path_val, is_sec, is_http, same_site, expires in c.fetchall():
            cookie_val = val
            if (not cookie_val) and enc_val:
                if enc_val.startswith(b'v10') or enc_val.startswith(b'v11'):
                    data = enc_val[3:]
                    cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
                    decryptor = cipher.decryptor()
                    decrypted = decryptor.update(data) + decryptor.finalize()
                    pad = decrypted[-1]
                    if isinstance(pad, int) and pad < 16:
                        decrypted = decrypted[:-pad]
                    # Strip 32-byte header/signature on newer Chrome/Brave builds
                    if len(decrypted) > 32:
                        cookie_val = decrypted[32:].decode('utf-8', errors='ignore')
                    else:
                        cookie_val = decrypted.decode('utf-8', errors='ignore')
                else:
                    cookie_val = enc_val.decode('utf-8', errors='ignore')

            if cookie_val:
                domain = host
                if domain.startswith('.'):
                    domain = domain[1:]

                s_map = {-1: 'Lax', 0: 'None', 1: 'Lax', 2: 'Strict'}
                cookies.append({
                    'name': name,
                    'value': cookie_val,
                    'domain': domain,
                    'path': path_val,
                    'secure': bool(is_sec),
                    'httpOnly': bool(is_http),
                    'sameSite': s_map.get(same_site, 'Lax'),
                })
        conn.close()
    except Exception:
        pass
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

    return cookies

def extract_all():
    candidates = [
        ('Brave', '~/.config/BraveSoftware/Brave-Browser/Default/Cookies'),
        ('Chrome', '~/.config/google-chrome/Default/Cookies'),
        ('Chromium', '~/.config/chromium/Default/Cookies'),
    ]

    for browser_name, path_str in candidates:
        cookies = get_cookies_from_path(browser_name, path_str)
        if cookies:
            return cookies

    return []

if __name__ == '__main__':
    print(json.dumps(extract_all()))
