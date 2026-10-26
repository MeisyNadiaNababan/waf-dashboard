# ============================================================
# KONFIGURASI
# ============================================================

import os

# Nilai di bawah bisa ditimpa lewat environment variable (docker-compose.yml)
KIBANA_HOST = os.getenv("KIBANA_HOST", "http://10.100.100.15:5601")
INDEX = os.getenv("KIBANA_INDEX", "big_ip-waf-logs-*")
KIBANA_USERNAME = os.getenv("KIBANA_USERNAME", "nyanwar")
KIBANA_PASSWORD = os.getenv("KIBANA_PASSWORD", '"*Xq5+R%[Kvr')

VS_NAME = "/Common/vs_api-gateway.bpbatam.go.id"

MONTHS_BACK_DEFAULT = 12

TOP_N_IP_DEFAULT = 20
TOP_N_URI_DEFAULT = 20
TOP_N_SIG_DEFAULT = 50
TOP_N_VIOLATION_DEFAULT = 100
TOP_N_RESPONSE_CODE_DEFAULT = 50

FLASK_HOST = "0.0.0.0"
FLASK_PORT = int(os.getenv("FLASK_PORT", "5000"))
FLASK_DEBUG = False

# ============================================================
# ANALISIS SERANGAN
# ============================================================
SEVERITY_ORDER = ["Critical", "High", "Medium", "Low"]
SEVERITY_RULES = [
    ("Low", [
        "cookie not rfc", "failed to convert character", "length",
        "illegal url length", "n/a",
    ]),
    ("Critical", [
        "attack signature", "threat campaign", "brute force",
        "csrf", "ssrf", "malicious", "backdoor", "shell", "sql injection",
        "command execution", "remote code", "rce", "deserialization",
    ]),
    ("High", [
        "evasion technique", "illegal file type", "illegal meta character",
        "illegal url", "illegal parameter", "illegal header", "illegal method",
        "data guard", "information leakage", "web scraping", "bot",
        "disallowed", "access from", "path traversal", "directory",
        "xss", "cross site", "ldap", "xml external", "xxe",
    ]),
    ("Medium", [
        "http protocol compliance", "malformed", "illegal repeated",
        "mandatory", "illegal query string", "illegal http status",
        "request content type", "cookies",
    ]),
]

# ============================================================
# THREAT LEVEL (v10) — Weighted Scoring
# ============================================================
THREAT_WEIGHT_ALERTED = 0.40
THREAT_WEIGHT_BLOCKED = 0.40
THREAT_WEIGHT_SPIKE   = 0.20

ALERTED_FULL_RATE = 4.0   # % (di atas ini, alerted score = 100)
BLOCKED_FULL_RATE = 2.0   # % (di atas ini, blocked score = 100)
SPIKE_FULL_RATIO  = 3.0   # 3x rata-rata harian -> spike score = 100

THREAT_TREND_MIN_DAYS   = 3     # rentang < 3 hari: spike tidak dihitung
THREAT_TREND_MIN_EVENTS = 50    # < 50 serangan 24 jam: dianggap normal (spike = 0)

# Kategori (upper bound exclusive)
THREAT_LEVELS = [
    (20,  "VERY LOW", "#00e676"),
    (40,  "LOW",      "#a8d84a"),
    (60,  "MEDIUM",   "#ffd54f"),
    (80,  "HIGH",     "#ff9f43"),
    (101, "CRITICAL", "#ff4757"),
]

TOP_N_ATTACK_VIOLATIONS = 50