import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from dateutil.relativedelta import relativedelta

from config import (
    MONTHS_BACK_DEFAULT,
    TOP_N_IP_DEFAULT, TOP_N_URI_DEFAULT, TOP_N_SIG_DEFAULT,
    TOP_N_VIOLATION_DEFAULT, TOP_N_RESPONSE_CODE_DEFAULT,
    SEVERITY_ORDER, SEVERITY_RULES,
    THREAT_WEIGHT_ALERTED, THREAT_WEIGHT_BLOCKED, THREAT_WEIGHT_SPIKE,
    ALERTED_FULL_RATE, BLOCKED_FULL_RATE, SPIKE_FULL_RATIO,
    THREAT_TREND_MIN_DAYS, THREAT_TREND_MIN_EVENTS, THREAT_LEVELS,
    TOP_N_ATTACK_VIOLATIONS,
)
from kibana_client import (
    create_kibana_session, run_query, datetime_to_es, time_range_filter,
)

WIB = ZoneInfo("Asia/Jakarta")
UTC = ZoneInfo("UTC")


# ============================================================
# RESOLVE RENTANG WAKTU
# ============================================================

def resolve_range(start=None, end=None, months_back=None):
    now = datetime.now(WIB)
    if start is not None and end is not None:
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
    if budget is None:
        budget = {"left": 40}
    budget["left"] -= 1
    q = build_q(cs, ce)
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
# HITUNGAN EKSAK
# ============================================================

def _hour_hist():
    return {"field": "@timestamp", "calendar_interval": "hour",
            "format": "dd-MM-yyyy|HH:00", "time_zone": "Asia/Jakarta", "min_doc_count": 1}


def _exact_terms(s, chunks, field, top_n, exclude=None, label=None):
    label = label or field
    cand_size = min(max(top_n * 3, 60), 1000)
    grand, approx = [0], {}

    def base(cs, ce):
        return time_range_filter(datetime_to_es(cs), datetime_to_es(ce))

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
    rows = [r for r in rows if r[2] in keep]
    rng = {"start": gs.isoformat(), "end": ge.isoformat()}
    return rng, grand, top, rows


# ---------- 2. RESPONSE CODE (Disesuaikan untuk tarik semua data) ----------

def fetch_response_code(months_back=MONTHS_BACK_DEFAULT, top_n=TOP_N_RESPONSE_CODE_DEFAULT, start=None, end=None):
    # Naikkan top_n agar mengambil semua respons code yang ada (misal 100)
    rng, grand, top, rows = _run_exact("response_code.keyword", max(top_n, 100), months_back, start, end, label="response_code")
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
            ip_exact[ip_b["key"]] = ip_exact.get(ip_b["key"], 0) + ip_b["doc_count"]
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


# ============================================================
# 8. ATTACK ANALYSIS (Heatmap + Severity + Threat Level v10)
# ============================================================
SEV_RANK = {s: i for i, s in enumerate(SEVERITY_ORDER)}


def classify_violation(name):
    best = None
    for part in re.split(r"[,;|]", str(name or "")):
        p = part.strip().lower()
        if not p:
            continue
        for sev, keys in SEVERITY_RULES:
            if any(k in p for k in keys):
                if best is None or SEV_RANK[sev] < SEV_RANK[best]:
                    best = sev
                break
    return best or "Unclassified"


def _attack_filter():
    """Request mencurigakan = bukan Clean."""
    return {"bool": {"should": [
        {"bool": {"filter": [{"exists": {"field": "violations.keyword"}}],
                  "must_not": [{"term": {"violations.keyword": "N/A"}}]}},
        {"match": {"request_status": "blocked"}},
        {"match": {"request_status": "alerted"}},
    ], "minimum_should_match": 1}}


def _bucket_dt(period, hour):
    dd, mm, yyyy = period.split("-")
    return datetime(int(yyyy), int(mm), int(dd), int(hour.split(":")[0]), tzinfo=WIB)


def _n(x, dec=0):
    return f"{x:,.{dec}f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _kategori(score):
    for bound, label, color in THREAT_LEVELS:
        if score < bound:
            return label, color
    last = THREAT_LEVELS[-1]
    return last[1], last[2]


def _threat_level_v10(total, alerted, blocked, suspicious_hourly, gs, ge):
    total = max(total, 1)
    alerted_rate = (alerted / total) * 100.0
    blocked_rate = (blocked / total) * 100.0

    alerted_score = min(100.0, (alerted_rate / ALERTED_FULL_RATE) * 100.0)
    blocked_score = min(100.0, (blocked_rate / BLOCKED_FULL_RATE) * 100.0)

    span_days = (ge - gs).total_seconds() / 86400.0
    last24 = 0
    spike_ratio = 0.0
    spike_score = 0.0
    if suspicious_hourly:
        cutoff = ge - timedelta(hours=24)
        for r in suspicious_hourly:
            if _bucket_dt(r["period"], r["hour"]) > cutoff - timedelta(hours=1):
                last24 += r["count"]

    detail_spike = ""
    if span_days < THREAT_TREND_MIN_DAYS:
        detail_spike = f"24 jam terakhir: {_n(last24)} aktivitas (rentang terlalu pendek untuk ukur lonjakan)"
    elif last24 < THREAT_TREND_MIN_EVENTS:
        detail_spike = f"24 jam terakhir: {_n(last24)} aktivitas (di bawah ambang {THREAT_TREND_MIN_EVENTS}, dianggap normal)"
    else:
        suspicious_total = sum(r["count"] for r in suspicious_hourly) if suspicious_hourly else 0
        prev_total = max(0, suspicious_total - last24)
        prev_days = max(span_days - 1.0, 1.0)
        base_daily = prev_total / prev_days if prev_days > 0 else 0
        if base_daily <= 0:
            spike_ratio = SPIKE_FULL_RATIO
        else:
            spike_ratio = last24 / base_daily
        spike_score = min(100.0, (spike_ratio / SPIKE_FULL_RATIO) * 100.0)
        detail_spike = (f"24 jam terakhir: {_n(last24)} aktivitas vs baseline harian {_n(base_daily)} "
                        f"({_n(spike_ratio, 2)}x)")

    score = int(round(
        alerted_score * THREAT_WEIGHT_ALERTED +
        blocked_score * THREAT_WEIGHT_BLOCKED +
        spike_score   * THREAT_WEIGHT_SPIKE
    ))
    score = max(0, min(100, score))
    status, color = _kategori(score)

    components = [
        {
            "key": "alerted",
            "label": f"Alerted Rate (bobot {int(THREAT_WEIGHT_ALERTED*100)}%)",
            "points": round(alerted_score * THREAT_WEIGHT_ALERTED, 1),
            "max": int(THREAT_WEIGHT_ALERTED * 100),
            "detail": (f"{_n(alerted)} dari {_n(total)} request ditandai Alerted "
                       f"({_n(alerted_rate, 2)}%) · skor komponen {_n(alerted_score, 1)}/100 "
                       f"(poin penuh di {_n(ALERTED_FULL_RATE, 1)}%)"),
        },
        {
            "key": "blocked",
            "label": f"Blocked Rate (bobot {int(THREAT_WEIGHT_BLOCKED*100)}%)",
            "points": round(blocked_score * THREAT_WEIGHT_BLOCKED, 1),
            "max": int(THREAT_WEIGHT_BLOCKED * 100),
            "detail": (f"{_n(blocked)} dari {_n(total)} request diblokir WAF "
                       f"({_n(blocked_rate, 2)}%) · skor komponen {_n(blocked_score, 1)}/100 "
                       f"(poin penuh di {_n(BLOCKED_FULL_RATE, 1)}%)"),
        },
        {
            "key": "spike",
            "label": f"Lonjakan 24 Jam (bobot {int(THREAT_WEIGHT_SPIKE*100)}%)",
            "points": round(spike_score * THREAT_WEIGHT_SPIKE, 1),
            "max": int(THREAT_WEIGHT_SPIKE * 100),
            "detail": detail_spike,
        },
    ]

    return {
        "score": score,
        "status": status,
        "color": color,
        "components": components,
        "alerted_rate_pct": round(alerted_rate, 3),
        "blocked_rate_pct": round(blocked_rate, 3),
        "spike_ratio": round(spike_ratio, 3),
        "last24_events": last24,
    }


def fetch_attack_analysis(months_back=MONTHS_BACK_DEFAULT, start=None, end=None):
    chunks, gs, ge = get_month_chunks(start, end, months_back)
    s = create_kibana_session()
    tot = {"total": 0, "attack": 0, "alerted": 0, "blocked": 0}
    hour_map, viol_cnt = {}, {}
    sev = {k: 0 for k in SEVERITY_ORDER}
    warnings = []

    def base(cs, ce):
        return time_range_filter(datetime_to_es(cs), datetime_to_es(ce))

    def build1(cs, ce):
        return {
            "size": 0, "track_total_hits": True,
            "query": {"bool": {"filter": base(cs, ce)}},
            "aggs": {"attack": {
                "filter": _attack_filter(),
                "aggs": {
                    "alerted": {"filter": {"match": {"request_status": "alerted"}}},
                    "blocked": {"filter": {"match": {"request_status": "blocked"}}},
                    "by_hour": {"date_histogram": _hour_hist()},
                    "violations": {"terms": {"field": "violations.keyword", "exclude": "N/A",
                                             "order": {"_count": "desc"}, "size": 500}},
                },
            }},
        }

    def cons1(d):
        tot["total"] += d["hits"]["total"]["value"]
        a = d["aggregations"]["attack"]
        tot["attack"] += a["doc_count"]
        tot["alerted"] += a["alerted"]["doc_count"]
        tot["blocked"] += a["blocked"]["doc_count"]
        for hb in a["by_hour"]["buckets"]:
            period, hour = hb["key_as_string"].split("|")
            k = (period, hour)
            hour_map[k] = hour_map.get(k, 0) + hb["doc_count"]
        for b in a["violations"]["buckets"]:
            viol_cnt[b["key"]] = viol_cnt.get(b["key"], 0) + b["doc_count"]

    try:
        for cs, ce in chunks:
            run_query_adaptive(s, build1, cs, ce, cons1, "attack:ringkasan")

        names_by_sev = {k: [] for k in SEVERITY_ORDER}
        for name in viol_cnt:
            c = classify_violation(name)
            if c in names_by_sev:
                names_by_sev[c].append(name)

        def build2(cs, ce):
            filters, higher = {}, []
            for k in SEVERITY_ORDER:
                names = names_by_sev[k]
                if names:
                    f = {"bool": {"filter": [{"terms": {"violations.keyword": names}}]}}
                    if higher:
                        f["bool"]["must_not"] = [{"terms": {"violations.keyword": list(higher)}}]
                    filters[k] = f
                    higher = higher + names
            return {"size": 0, "track_total_hits": False,
                    "query": {"bool": {"filter": base(cs, ce)}},
                    "aggs": {"sev": {"filters": {"filters": filters}}}}

        def cons2(d):
            for k, b in d["aggregations"]["sev"]["buckets"].items():
                sev[k] += b["doc_count"]

        if any(names_by_sev.values()):
            try:
                for cs, ce in chunks:
                    run_query_adaptive(s, build2, cs, ce, cons2, "attack:severity")
            except Exception as e:
                sev = {k: 0 for k in SEVERITY_ORDER}
                warnings.append(f"Severity gagal dihitung: {e}"); print(e)
    finally:
        s.close()

    attack = tot["attack"]
    alerted = min(tot["alerted"], attack)
    blocked = min(tot["blocked"], attack)

    classified = sum(sev.values())
    sev_full = dict(sev)
    sev_full["Unclassified"] = max(0, attack - classified)

    hourly = [{"period": p, "hour": h, "count": c} for (p, h), c in hour_map.items()]
    vrows = sorted(viol_cnt.items(), key=lambda x: x[1], reverse=True)
    violations = [{"violation": n, "severity": classify_violation(n), "count": c}
                  for n, c in vrows[:TOP_N_ATTACK_VIOLATIONS]]
    unclassified = [{"violation": n, "count": c} for n, c in vrows
                    if classify_violation(n) == "Unclassified"][:10]

    threat = _threat_level_v10(tot["total"], alerted, blocked, hourly, gs, ge)

    return {
        "range": {"start": gs.isoformat(), "end": ge.isoformat()},
        "grand_total": tot["total"],
        "attack_total": attack,
        "attack_alerted": alerted,
        "attack_blocked": blocked,
        "hourly": hourly,
        "severity": sev_full,
        "violations": violations,
        "unclassified": unclassified,
        "threat": threat,
        "warnings": warnings,
    }


# ---------- 9. RAW LOG DETAIL (Live Log Stream) ----------

_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _to_wib(ts):
    if not ts:
        return None, 0.0
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return str(ts), 0.0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    w = dt.astimezone(WIB)
    label = f"{_MON[w.month-1]} {w.day}, {w.year} @ {w:%H:%M:%S}.{w.microsecond // 1000:03d}"
    return label, dt.timestamp()


def fetch_raw_log_detail(months_back=1, page_size=500, max_docs=2000, start=None, end=None):
    chunks, gs, ge = get_month_chunks(start, end, months_back)
    s = create_kibana_session()
    rows, fetched = [], 0
    try:
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
                    "query": {"bool": {"filter": time_range_filter(gte, lt)}},
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
                    wib_str, epoch = _to_wib(gv("@timestamp"))
                    rows.append({
                        "support_id": gv("support_id"),
                        "log_time": wib_str,
                        "log_epoch": epoch,
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

    rows.sort(key=lambda r: r["log_epoch"], reverse=True)
    rows = rows[:max_docs]
    return {"range": {"start": gs.isoformat(), "end": ge.isoformat()},
            "fetched_at": datetime.now(WIB).strftime("%Y-%m-%d %H:%M:%S"),
            "latest_log_time": rows[0]["log_time"] if rows else None,
            "latest_epoch": rows[0]["log_epoch"] if rows else 0,
            "total_fetched": len(rows), "rows": rows}