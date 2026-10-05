from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from dateutil.relativedelta import relativedelta

from config import (
    MONTHS_BACK_DEFAULT,
    TOP_N_IP_DEFAULT, TOP_N_URI_DEFAULT, TOP_N_SIG_DEFAULT,
    TOP_N_VIOLATION_DEFAULT, TOP_N_RESPONSE_CODE_DEFAULT,
)
from kibana_client import (
    create_kibana_session, run_query, datetime_to_es, time_range_filter,
)

WIB = ZoneInfo("Asia/Jakarta")


# ============================================================
# RESOLVE RENTANG WAKTU
# Terima (start, end) dalam WIB tz-aware, atau months_back.
# ============================================================

def resolve_range(start=None, end=None, months_back=None):
    now = datetime.now(WIB)
    if start is not None and end is not None:
        # Pastikan tz-aware
        if start.tzinfo is None:
            start = start.replace(tzinfo=WIB)
        if end.tzinfo is None:
            end = end.replace(tzinfo=WIB)
        return start, end
    mb = months_back if months_back is not None else MONTHS_BACK_DEFAULT
    gs = (now - relativedelta(months=mb)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return gs, now


def get_month_chunks(start=None, end=None, months_back=None):
    gs, ge = resolve_range(start, end, months_back)
    chunks, cur = [], gs
    while cur < ge:
        nxt = (cur.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
               + relativedelta(months=1))
        ce = min(nxt, ge)
        chunks.append((cur, ce))
        cur = ce
    return chunks, gs, ge


def run_query_adaptive(s, build_q, cs, ce, consume, label="query", budget=None, depth=0):
    """Jalankan query untuk [cs, ce). Jika gagal (timeout Kibana 30 dtk / too_many_buckets /
    shard gagal), rentang dibelah dua lalu diulang. 'budget' membatasi total percobaan
    supaya tidak menggantung. Error terakhir dilempar dengan pesan yang jelas."""
    if budget is None:
        budget = {"left": 40}
    budget["left"] -= 1
    q = build_q(cs, ce)          # error kode (bukan error ES) langsung muncul
    try:
        data = run_query(s, q)
    except Exception as e:
        small = (ce - cs) <= timedelta(hours=6)
        if depth >= 6 or small or budget["left"] <= 0:
            raise RuntimeError(
                f"[{label}] gagal {cs:%Y-%m-%d %H:%M} -> {ce:%Y-%m-%d %H:%M}: {type(e).__name__}: {e}"
            ) from e
        print(f"[{label}] gagal ({type(e).__name__}: {str(e)[:120]}) -> belah rentang, depth={depth+1}")
        mid = cs + (ce - cs) / 2
        run_query_adaptive(s, build_q, cs, mid, consume, label, budget, depth + 1)
        run_query_adaptive(s, build_q, mid, ce, consume, label, budget, depth + 1)
        return
    consume(data)


# ---------- 1. REQUEST DISTRIBUTION ----------

def _status_agg():
    return {
        "filters": {
            "filters": {
                "Clean": {"bool": {"filter": [{"bool": {"filter": [
                    {"bool": {"should": [{"term": {"violations.keyword": {"value": "N/A"}}}], "minimum_should_match": 1}},
                    {"bool": {"should": [{"match": {"request_status": "passed"}}], "minimum_should_match": 1}},
                ]}}]}},
                "Blocked": {"bool": {"filter": [{"bool": {"should": [{"match": {"request_status": "blocked"}}], "minimum_should_match": 1}}]}},
                "Alerted": {"bool": {"filter": [{"bool": {"should": [{"match": {"request_status": "alerted"}}], "minimum_should_match": 1}}]}},
            }
        }
    }


def fetch_request_distribution(months_back=MONTHS_BACK_DEFAULT, start=None, end=None):
    chunks, gs, ge = get_month_chunks(start, end, months_back)
    s = create_kibana_session()
    hourly, totals = [], {"Clean": 0, "Blocked": 0, "Alerted": 0}
    grand = 0
    try:
        for cs, ce in chunks:
            q = {
                "size": 0, "track_total_hits": True,
                "query": {"bool": {"filter": time_range_filter(datetime_to_es(cs), datetime_to_es(ce))}},
                "aggs": {
                    "total_status": _status_agg(),
                    "by_hour": {
                        "date_histogram": {
                            "field": "@timestamp", "calendar_interval": "hour",
                            "format": "dd-MM-yyyy|HH:00", "time_zone": "Asia/Jakarta",
                            "min_doc_count": 0,
                        },
                        "aggs": {"request_status": _status_agg()},
                    },
                },
            }
            data = run_query(s, q)
            grand += data["hits"]["total"]["value"]
            for cat, b in data["aggregations"]["total_status"]["buckets"].items():
                totals[cat] += b["doc_count"]
            for hb in data["aggregations"]["by_hour"]["buckets"]:
                period, hour = hb["key_as_string"].split("|")
                for cat, b in hb["request_status"]["buckets"].items():
                    hourly.append({"period": period, "hour": hour, "category": cat, "request_count": b["doc_count"]})
    finally:
        s.close()
    return {"range": {"start": gs.isoformat(), "end": ge.isoformat()},
            "grand_total": grand, "totals_by_category": totals, "hourly": hourly}


# ============================================================
# HITUNGAN EKSAK (tanpa pemotongan Top-N / pembulatan)
# Cara lama menjumlahkan "Top-N per jam / per bulan": item yang kebetulan di luar
# Top-N pada satu jam hilang dari totalnya -> angka lebih kecil dari Kibana.
#   Tahap 1: cari KANDIDAT (union Top-K tiap bulan, K = 3 x top_n)
#   Tahap 2: hitung ulang HANYA kandidat, dgn terms.include + size = jumlah
#            kandidat -> tidak ada bucket yang terpotong -> doc_count eksak.
# ============================================================

def _hour_hist():
    return {"field": "@timestamp", "calendar_interval": "hour",
            "format": "dd-MM-yyyy|HH:00", "time_zone": "Asia/Jakarta", "min_doc_count": 1}


def _exact_terms(s, chunks, field, top_n, exclude=None, label=None):
    """return (grand_total_docs, {key: count_eksak}, [(period, hour, key, count)])"""
    label = label or field
    cand_size = min(max(top_n * 3, 60), 1000)
    grand, approx = [0], {}

    def base(cs, ce):
        return time_range_filter(datetime_to_es(cs), datetime_to_es(ce))

    # ---- tahap 1: kandidat ----
    def build1(cs, ce):
        t = {"field": field, "order": {"_count": "desc"},
             "size": cand_size, "shard_size": min(cand_size * 5, 5000)}
        if exclude:
            t["exclude"] = exclude
        return {"size": 0, "track_total_hits": True,
                "query": {"bool": {"filter": base(cs, ce)}},
                "aggs": {"t": {"terms": t}}}

    def cons1(d):
        grand[0] += d["hits"]["total"]["value"]
        for b in d["aggregations"]["t"]["buckets"]:
            approx[b["key"]] = approx.get(b["key"], 0) + b["doc_count"]

    for cs, ce in chunks:
        run_query_adaptive(s, build1, cs, ce, cons1, f"{label}:kandidat")

    cands = [k for k, _ in sorted(approx.items(), key=lambda x: x[1], reverse=True)[:cand_size]]
    totals, rows = {}, []
    if not cands:
        return grand[0], totals, rows

    # ---- tahap 2: hitung eksak untuk kandidat ----
    def tagg():
        return {"terms": {"field": field, "include": cands, "size": len(cands),
                          "order": {"_count": "desc"}}}

    def build2(cs, ce):
        return {"size": 0, "track_total_hits": False,
                "query": {"bool": {"filter": base(cs, ce) + [{"terms": {field: cands}}]}},
                "aggs": {"t": tagg(),
                         "by_hour": {"date_histogram": _hour_hist(), "aggs": {"t": tagg()}}}}

    def cons2(d):
        for b in d["aggregations"]["t"]["buckets"]:
            totals[b["key"]] = totals.get(b["key"], 0) + b["doc_count"]
        for hb in d["aggregations"]["by_hour"]["buckets"]:
            period, hour = hb["key_as_string"].split("|")
            for b in hb["t"]["buckets"]:
                rows.append((period, hour, b["key"], b["doc_count"]))

    for cs, ce in chunks:
        run_query_adaptive(s, build2, cs, ce, cons2, f"{label}:eksak")
    return grand[0], totals, rows


def _run_exact(field, top_n, months_back, start, end, exclude=None, label=None):
    chunks, gs, ge = get_month_chunks(start, end, months_back)
    s = create_kibana_session()
    try:
        grand, totals, rows = _exact_terms(s, chunks, field, top_n, exclude, label)
    finally:
        s.close()
    top = sorted(totals.items(), key=lambda x: x[1], reverse=True)[:top_n]
    keep = {k for k, _ in top}
    rows = [r for r in rows if r[2] in keep]       # hanya item Top-N yang dikirim
    rng = {"start": gs.isoformat(), "end": ge.isoformat()}
    return rng, grand, top, rows


# ---------- 2. RESPONSE CODE ----------

def fetch_response_code(months_back=MONTHS_BACK_DEFAULT, top_n=TOP_N_RESPONSE_CODE_DEFAULT, start=None, end=None):
    rng, grand, top, rows = _run_exact("response_code.keyword", top_n, months_back, start, end, label="response_code")
    return {"range": rng, "grand_total": grand, "totals_by_code": dict(top),
            "hourly": [{"period": p, "hour": h, "response_code": k, "request_count": c} for p, h, k, c in rows]}


# ---------- 3. TOP CLIENT IP ----------

def fetch_top_client_ip(months_back=MONTHS_BACK_DEFAULT, top_n=TOP_N_IP_DEFAULT, start=None, end=None):
    rng, grand, top, rows = _run_exact("ip_client.keyword", top_n, months_back, start, end, label="top_ip")
    return {"range": rng, "grand_total": grand,
            "top": [{"ip_client": k, "request_count": v} for k, v in top],
            "hourly": [{"period": p, "hour": h, "ip_client": k, "request_count": c} for p, h, k, c in rows]}


# ---------- 4. TOP URL ----------

def fetch_top_url(months_back=MONTHS_BACK_DEFAULT, top_n=TOP_N_URI_DEFAULT, start=None, end=None):
    rng, grand, top, rows = _run_exact("uri.keyword", top_n, months_back, start, end, label="top_url")
    return {"range": rng, "grand_total": grand,
            "top": [{"uri": k, "request_count": v} for k, v in top],
            "hourly": [{"period": p, "hour": h, "uri": k, "request_count": c} for p, h, k, c in rows]}


# ---------- 5. TOP SIGNATURES ----------

def fetch_top_signatures(months_back=MONTHS_BACK_DEFAULT, top_n=TOP_N_SIG_DEFAULT, start=None, end=None):
    rng, grand, top, rows = _run_exact("sig_ids.keyword", top_n, months_back, start, end, exclude="N/A", label="signatures")
    return {"range": rng, "grand_total": grand,
            "top": [{"sig_id": k, "request_count": v} for k, v in top],
            "hourly": [{"period": p, "hour": h, "sig_id": k, "request_count": c} for p, h, k, c in rows]}


# ---------- 6. VIOLATIONS ----------

def fetch_violations(months_back=MONTHS_BACK_DEFAULT, top_n=TOP_N_VIOLATION_DEFAULT, start=None, end=None):
    rng, grand, top, rows = _run_exact("violations.keyword", top_n, months_back, start, end, exclude="N/A", label="violations")
    return {"range": rng, "grand_total": grand,
            "top": [{"violation": k, "violation_count": v} for k, v in top],
            "hourly": [{"period": p, "hour": h, "violation": k, "violation_count": c} for p, h, k, c in rows]}


# ---------- 7. TOP VIOLATOR IP ----------
# Dibuat ringan supaya tidak kena timeout Kibana (default 30 dtk) / max_buckets:
#   A. by_hour : jam x violation (tanpa IP)             -> heatmap  (hourly)
#   B. top_ip  : terms IP saja, TANPA sub-agregasi      -> daftar IP teratas
#   C. by_ip   : filter hanya IP teratas, IP x violation -> chart & modal (by_ip)
# Tiap tahap diisolasi: kalau satu gagal, tahap lain tetap dikembalikan
# dan alasannya masuk ke field "warnings" (bukan menggagalkan seluruh data).

def _ip_violation_sub(top_v):
    return {"terms": {"field": "violations.keyword", "order": {"_count": "desc"},
                      "size": top_v, "exclude": "N/A"}}


def _viol_filter(cs, ce, ips=None):
    f = {"bool": {
        "filter": time_range_filter(datetime_to_es(cs), datetime_to_es(ce)),
        "must_not": [{"term": {"violations.keyword": "N/A"}}],
    }}
    if ips:
        f["bool"]["filter"] = f["bool"]["filter"] + [{"terms": {"ip_client.keyword": list(ips)}}]
    return f


def fetch_top_violator_ip(months_back=MONTHS_BACK_DEFAULT,
                          top_n_ip=50, top_v=50,
                          start=None, end=None):
    chunks, gs, ge = get_month_chunks(start, end, months_back)
    s = create_kibana_session()
    hourly_map, ip_totals, ip_viol = {}, {}, {}
    grand = [0]
    warnings = []

    # ---- A. heatmap ----
    def build_hour(cs, ce):
        return {
            "size": 0, "track_total_hits": True,
            "query": _viol_filter(cs, ce),
            "aggs": {"by_hour": {
                "date_histogram": {
                    "field": "@timestamp", "calendar_interval": "hour",
                    "format": "dd-MM-yyyy|HH:00", "time_zone": "Asia/Jakarta",
                    "min_doc_count": 1,
                },
                "aggs": {"violations": _ip_violation_sub(top_v)},
            }},
        }

    def consume_hour(data):
        grand[0] += data["hits"]["total"]["value"]
        for hb in data["aggregations"]["by_hour"]["buckets"]:
            period, hour = hb["key_as_string"].split("|")
            for v in hb["violations"]["buckets"]:
                k = (period, hour, v["key"])
                hourly_map[k] = hourly_map.get(k, 0) + v["doc_count"]

    # ---- B. IP teratas (tanpa sub-agg) ----
    def build_top(cs, ce):
        return {
            "size": 0, "track_total_hits": False,
            "query": _viol_filter(cs, ce),
            "aggs": {"client_ip": {"terms": {
                "field": "ip_client.keyword", "order": {"_count": "desc"},
                "size": top_n_ip, "shard_size": top_n_ip * 5}}},
        }

    def consume_top(data):
        for b in data["aggregations"]["client_ip"]["buckets"]:
            ip_totals[b["key"]] = ip_totals.get(b["key"], 0) + b["doc_count"]

    # ---- C. IP x violation, hanya untuk IP teratas ----
    def make_build_ip(ips):
        def build_ip(cs, ce):
            return {
                "size": 0, "track_total_hits": False,
                "query": _viol_filter(cs, ce, ips),
                "aggs": {"client_ip": {
                    "terms": {"field": "ip_client.keyword", "order": {"_count": "desc"},
                              "size": len(ips)},
                    "aggs": {"violations": _ip_violation_sub(top_v)},
                }},
            }
        return build_ip

    ip_exact = {}

    def consume_ip(data):
        for ip_b in data["aggregations"]["client_ip"]["buckets"]:
            ip_exact[ip_b["key"]] = ip_exact.get(ip_b["key"], 0) + ip_b["doc_count"]   # eksak (difilter ke IP teratas)
            for v in ip_b["violations"]["buckets"]:
                k = (ip_b["key"], v["key"])
                ip_viol[k] = ip_viol.get(k, 0) + v["doc_count"]

    try:
        for cs, ce in chunks:
            try:
                run_query_adaptive(s, build_hour, cs, ce, consume_hour, "violator:heatmap")
            except Exception as e:
                warnings.append(str(e)); print(e)
            try:
                run_query_adaptive(s, build_top, cs, ce, consume_top, "violator:top_ip")
            except Exception as e:
                warnings.append(str(e)); print(e)

        top = sorted(ip_totals.items(), key=lambda x: x[1], reverse=True)[:top_n_ip]
        top_ips = [k for k, _ in top]
        if top_ips:
            for cs, ce in chunks:
                try:
                    run_query_adaptive(s, make_build_ip(top_ips), cs, ce, consume_ip, "violator:by_ip")
                except Exception as e:
                    warnings.append(str(e)); print(e)
    finally:
        s.close()

    # semua tahap gagal -> baru dianggap error
    if not hourly_map and not ip_totals and warnings:
        raise RuntimeError(" | ".join(warnings[:3]))

    hourly = [{"period": p, "hour": h, "violation": v, "violation_count": c}
              for (p, h, v), c in hourly_map.items()]
    by_ip = [{"ip_client": ip, "violation": v, "violation_count": c,
              "total_request_ip": ip_exact.get(ip, ip_totals.get(ip, 0))}
             for (ip, v), c in ip_viol.items()]
    by_ip.sort(key=lambda r: r["violation_count"], reverse=True)
    return {"range": {"start": gs.isoformat(), "end": ge.isoformat()}, "grand_total": grand[0],
            "top_ips": [{"ip_client": k, "total_request_ip": v} for k, v in top],
            "hourly": hourly, "by_ip": by_ip, "warnings": warnings[:5]}


# ---------- 8. RAW LOG DETAIL ----------

def fetch_raw_log_detail(months_back=1, page_size=500, max_docs=2000, start=None, end=None):
    chunks, gs, ge = get_month_chunks(start, end, months_back)
    s = create_kibana_session()
    rows, fetched = [], 0
    try:
        # log TERBARU dulu: bulan terakhir lebih dulu, urutan waktu menurun
        for cs, ce in reversed(chunks):
            gte = datetime_to_es(cs); lt = datetime_to_es(ce)
            search_after = None
            while True:
                q = {
                    "size": page_size,
                    "sort": [{"@timestamp": {"order": "desc", "unmapped_type": "boolean"}},
                             {"_doc": {"order": "desc", "unmapped_type": "boolean"}}],
                    "fields": [
                        {"field": "support_id"}, {"field": "ip_client"},
                        {"field": "source.ip"}, {"field": "host.ip"},
                        {"field": "x_forwarded_for_header_value"},
                        {"field": "dest_port"}, {"field": "method"},
                        {"field": "uri"}, {"field": "response_code"},
                        {"field": "request_status"},
                        {"field": "@timestamp", "format": "strict_date_optional_time"},
                    ],
                    "_source": False,
                    "query": {"bool": {"filter": time_range_filter(gte, lt) + [{"exists": {"field": "support_id"}}]}},
                }
                if search_after: q["search_after"] = search_after
                data = run_query(s, q)
                hits = data["hits"]["hits"]
                if not hits: break
                for h in hits:
                    f = h.get("fields", {})
                    def gv(k):
                        v = f.get(k)
                        return v[0] if isinstance(v, list) and v else (v if not isinstance(v, list) else None)
                    rows.append({
                        "support_id": gv("support_id"),
                        "log_time": gv("@timestamp"),
                        "ip_client": gv("ip_client"),
                        "method": gv("method"),
                        "uri": gv("uri"),
                        "request_status": gv("request_status"),
                        "response_code": gv("response_code"),
                        "source_ip": gv("source.ip"),
                        "host_ip": gv("host.ip"),
                        "dest_port": gv("dest_port"),
                        "x_forwarded_for": gv("x_forwarded_for_header_value"),
                    })
                fetched += len(hits)
                search_after = hits[-1]["sort"]
                if len(hits) < page_size or fetched >= max_docs: break
            if fetched >= max_docs: break
    finally:
        s.close()
    return {"range": {"start": gs.isoformat(), "end": ge.isoformat()},
            "total_fetched": fetched, "rows": rows[:max_docs]}