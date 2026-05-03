# 🔐 WebApp Template

[![Python](https://img.shields.io/badge/Python-3.8+-blue.svg)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688.svg)](https://fastapi.tiangolo.com)
[![SQLite](https://img.shields.io/badge/SQLite-003B57.svg)](https://sqlite.org)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A template for websites and web applications built with **FastAPI**, **SQLite**, and vanilla **HTML/CSS/JS**.
---

## ✨ Features
Authentication:
- 🔑 **Multi-server Authentication** — Log in via peer servers with `username@hostname.example` syntax
- 🔢 **HOTP Invite Codes** — Invite new users with one-time, one-at-a-time invite codes
- 📱 **TOTP 2FA Support** — QR code-based two-factor authentication
- 🍪 **Session Management** — 24-hour session tokens stored in localStorage
- 🗄️ **SQLite Backend** — Lightweight database
- ⚡ **FastAPI Powered** — High-performance async Python backend

---

## 🚀 Quick Start

Get the example server running in seconds:

```bash
./setup.sh
```

---

## 📖 Usage Guide

### 1. User Registration

New users can register using an invite code, (example invite code generation in `get_invite_code` function). The invite code format is:

```
username_123456
```

> **Format:** `invitee's username` + `_` + `HOTP code`

![Invite Code Entry](https://github.com/HommelWater/Authentification-Template/blob/main/images/auth_example_1.png?raw=true)

---

### 2. Setup 2FA

After registration, scan the QR code with your authenticator app (Google Authenticator, Authy, etc.) to store the TOTP secret key.

![Sign Up Process](https://github.com/HommelWater/Authentification-Template/blob/main/images/auth_example_2.png?raw=true)

---

### 3. Login

Enter your TOTP code to authenticate. The system automatically routes to friendly peer servers when using `username@hostname.example` syntax. Peer servers do not see private information of the user.

![Login Screen](https://github.com/HommelWater/Authentification-Template/blob/main/images/auth_example_3.png?raw=true)

---

### 4. Session Token

Upon successful login, the session token is stored in `localStorage`:

```javascript
const sessionKey = localStorage.getItem("session");
// Valid for 24 hours by default
```

---

## 🔌 Peer Server Authentication

Configure peer servers in `server.py`:

```python
peers = [
    "hostname.example",
    "auth.partner-site.com"
]
```

Login via peer server:
```
username@hostname.example
```

The UI automatically routes the request to the appropriate peer server.

---

## 🛠️ API Reference

See API.md