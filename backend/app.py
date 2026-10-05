import traceback
from datetime import datetime
from threading import Lock

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

import data_service
from config import FLASK_HOST, FLASK_PORT, FLASK_DEBUG, MONTHS_BACK_DEFAULT

app = Flask(__name__, static_folder="../frontend", static_url_path="")
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0   # selalu ambil JS/CSS terbaru
CORS(app)

_cache, _lock = {}, Lock()

SUPPORTED = {
    "request_distribution": data_service.fetch_request_distribution,
    "response_code":        data_service.fetch_response_code,
    "top_client_ip":        data_service.fetch_top_client_ip,
    "top_url":              data_service.fetch_top_url,
    "top_signatures":       data_service.fetch_top_signatures,
    "violations":           data_service.fetch_violations,
    "top_violator_ip":      data_service.fetch_top_violator_ip,
    "raw_log_detail":       data_service.fetch_raw_log_detail,
}


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "time": datetime.now().isoformat(),
                    "supported": list(SUPPORTED.keys())})


@app.route("/api/refresh/<data_type>", methods=["POST", "GET"])
def refresh(data_type):
    if data_type not in SUPPORTED:
        return jsonify({"error": f"data_type '{data_type}' tidak dikenal"}), 400

    # Baca parameter: bisa months_back, atau start_iso + end_iso (kustom)
    start_iso = request.args.get("start_iso")  # format: 2026-02-02T00:00:00+07:00
    end_iso = request.args.get("end_iso")
    months_back = request.args.get("months_back")

    try:
        started = datetime.now()
        fn = SUPPORTED[data_type]

        if start_iso and end_iso:
            # Mode kustom (rentang tanggal dari date picker)
            result = fn(start=datetime.fromisoformat(start_iso),
                        end=datetime.fromisoformat(end_iso))
        else:
            # Mode months_back (fallback)
            mb = int(months_back or MONTHS_BACK_DEFAULT)
            if data_type == "raw_log_detail":
                result = fn(months_back=min(mb, 3))
            else:
                result = fn(months_back=mb)

        with _lock:
            _cache[data_type] = {"fetched_at": datetime.now().isoformat(), "data": result}

        return jsonify({
            "status": "ok",
            "data_type": data_type,
            "fetched_at": _cache[data_type]["fetched_at"],
            "elapsed_seconds": (datetime.now() - started).total_seconds(),
            "data": result,
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "data_type": data_type,
                        "error": str(e), "traceback": traceback.format_exc()}), 500


@app.route("/api/data/<data_type>")
def get_cached(data_type):
    with _lock:
        if data_type not in _cache:
            return jsonify({"status": "empty", "data_type": data_type}), 404
        return jsonify({"status": "ok", "data_type": data_type,
                        "fetched_at": _cache[data_type]["fetched_at"],
                        "data": _cache[data_type]["data"]})


@app.route("/api/cache/status")
def cache_status():
    with _lock:
        return jsonify({k: v["fetched_at"] for k, v in _cache.items()})


if __name__ == "__main__":
    print("=" * 70)
    print(f"WAF DASHBOARD -> http://localhost:{FLASK_PORT}")
    print("=" * 70)
    app.run(host=FLASK_HOST, port=FLASK_PORT, debug=FLASK_DEBUG, threaded=True)