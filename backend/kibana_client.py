import json
import requests
from zoneinfo import ZoneInfo
from config import KIBANA_HOST, INDEX, KIBANA_USERNAME, KIBANA_PASSWORD, VS_NAME

UTC = ZoneInfo("UTC")


def datetime_to_es(dt):
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def create_kibana_session():
    s = requests.Session()
    s.headers.update({"kbn-xsrf": "true", "Content-Type": "application/json"})
    r = s.post(
        f"{KIBANA_HOST}/internal/security/login",
        json={
            "providerType": "basic",
            "providerName": "basic",
            "currentURL": f"{KIBANA_HOST}/",
            "params": {"username": KIBANA_USERNAME, "password": KIBANA_PASSWORD},
        },
        timeout=30,
    )
    r.raise_for_status()
    return s


def run_query(session, query):
    r = session.post(
        f"{KIBANA_HOST}/api/console/proxy",
        params={"path": f"{INDEX}/_search", "method": "POST"},
        data=json.dumps(query),
        timeout=120,
    )
    r.raise_for_status()
    result = r.json()
    if result.get("timed_out"):
        raise RuntimeError("Elasticsearch timed_out=true")
    sh = result.get("_shards", {})
    if sh.get("failed", 0) > 0:
        raise RuntimeError(f"{sh.get('failed')} shard gagal")
    return result


def time_range_filter(gte_utc, lt_utc):
    return [
        {"match_phrase": {"vs_name": VS_NAME}},
        {
            "range": {
                "@timestamp": {
                    "format": "strict_date_optional_time",
                    "gte": gte_utc,
                    "lt": lt_utc,
                }
            }
        },
    ]