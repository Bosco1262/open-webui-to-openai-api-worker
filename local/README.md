# Local Credential Capture

[English](README.md) | [简体中文](README.zh-CN.md)

Used to obtain the Open WebUI login credentials (`session.json`) locally, which are then pasted into the Worker admin console for import.

## Installation

Requires Python 3.9+:

```bash
cd local
pip install -r requirements.txt
playwright install chromium
```

## Usage

```bash
python login.py --base-url https://your-open-webui.example.com
```

After running:

1. A Chromium browser window opens automatically;
2. Complete the Open WebUI login manually in the window (if it redirects to a campus/corporate network portal, finish the network authentication first);
3. The script captures the login credentials in the background and **performs a real authentication check against the upstream** (to avoid capturing expired tokens or invalid credentials produced by portal redirects);
4. After verification passes, the browser closes automatically, `session.json` is saved to the current directory, and the **full JSON content is printed in the terminal**:

```
==============================================================
  Copy ALL of the JSON below and paste it into "Import Session"
  in the Worker admin console.
==============================================================
{
  "authorization": "Bearer eyJhbGciOiJIUzI1NiIs...",
  "cookie": "token=eyJ...; oauth_id_token=...; oauth_session_id=...",
  "user_agent": "Mozilla/5.0 ...",
  "captured_at": 1788268041.75,
  "base_url": "https://your-open-webui.example.com"
}
==============================================================
```

5. Copy the JSON above → open the Worker admin console `/admin` → **Import Session** card → paste and import.

## Common Options

| Option           | Default                        | Description                                                       |
| ---------------- | ------------------------------ | ----------------------------------------------------------------- |
| `--base-url`     | env var `OPEN_WEBUI_BASE_URL`  | Open WebUI URL; must include the `http(s)://` prefix              |
| `--timeout`      | `600`                          | Max seconds to wait for login                                     |
| `--quiet-period` | `6`                            | Quiet observation period after capture (seconds)                  |
| `--headless`     | `false`                        | Launch the browser in headless mode                               |
| `--output`       | `session.json`                 | Output file path                                                  |
| `--insecure`     | `false`                        | Skip upstream HTTPS certificate verification (use with caution)   |
| `--lang`         | `auto`                         | Output language: `zh` / `en` / `auto` (auto = system language)    |

```bash
python login.py --base-url https://chat.example.com --timeout 900
python login.py --base-url https://chat.example.com --output my-session.json
python login.py --base-url https://chat.example.com --lang en
```

### Output Language

All terminal output (banner, logs, errors, `--help` text) is localized in Chinese / English. Language selection priority:

1. `--lang zh` / `--lang en` — explicit CLI flag (highest priority);
2. System language detection — env vars (`LANG` / `LC_ALL` etc.) or the Windows UI language;
3. English — the default when detection fails.

The `--help` output follows `--lang` as well, e.g. `python login.py --lang en --help` always shows English help.

## Notes

- Credentials are only considered valid after passing a real upstream authentication check, avoiding saving "expired-token probing requests" or "unauthenticated campus portal redirects" as valid credentials.
- `session.json` is in `.gitignore`; do not commit it to version control.
- When the Open WebUI JWT expires (typically a few days, depending on the server's `JWT_EXPIRES_IN`), simply rerun this tool to refresh it.

## License

This project is licensed under the [MIT License](LICENSE).
