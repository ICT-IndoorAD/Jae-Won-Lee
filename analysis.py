"""실내 공기질 로그 로딩 및 이상 탐지/추이 분석 (표준 라이브러리 전용)."""

import bisect
import csv
import math
import os
import statistics
import threading
import time
from collections import defaultdict
from datetime import datetime

# ---------------------------------------------------------------------------
# 설정
# ---------------------------------------------------------------------------

# key: CSV 컬럼, group: 임계값 그룹, flat_min: 값이 이 시간(분) 이상 완전히 고정되면 센서 이상
# min_scale: 통계적 이상(robust z) 계산 시 MAD 하한, min_delta: 급변으로 볼 최소 변화량
METRICS = [
    {"key": "dht_temp_C", "label": "온도 (DHT)", "unit": "°C", "group": "temp", "flat_min": 240, "min_scale": 0.15, "min_delta": 1.0},
    {"key": "am_temp_C", "label": "온도 (AM)", "unit": "°C", "group": "temp", "flat_min": 240, "min_scale": 0.15, "min_delta": 1.0},
    {"key": "dht_humi_pct", "label": "습도 (DHT)", "unit": "%", "group": "humi", "flat_min": 240, "min_scale": 0.7, "min_delta": 5.0},
    {"key": "am_humi_pct", "label": "습도 (AM)", "unit": "%", "group": "humi", "flat_min": 240, "min_scale": 0.7, "min_delta": 5.0},
    {"key": "co2_ppm", "label": "CO₂", "unit": "ppm", "group": "co2", "flat_min": 60, "min_scale": 15, "min_delta": 150},
    {"key": "voc_level", "label": "VOC 등급", "unit": "", "group": "voc", "flat_min": None, "min_scale": 0.5, "min_delta": 99},
    {"key": "pm25_ugm3", "label": "PM2.5", "unit": "µg/m³", "group": "pm25", "flat_min": None, "min_scale": 2.0, "min_delta": 20},
]
KEYS = [m["key"] for m in METRICS]
META = {m["key"]: m for m in METRICS}

# 대표 지표 (KPI/추이 분석 기준). 온·습도는 장기간 유효한 DHT 센서를 기준으로 사용.
PRIMARY = ["dht_temp_C", "dht_humi_pct", "co2_ppm", "pm25_ugm3", "voc_level"]

# 임계값: 실내공기질관리법 유지/권고기준 및 일반 쾌적 범위 참고. 값 '초과' 시 해당 단계.
THRESHOLDS = {
    "temp": {"low_danger": 16, "low_caution": 18, "high_caution": 26, "high_danger": 28},
    "humi": {"low_danger": 20, "low_caution": 30, "high_caution": 60, "high_danger": 70},
    "co2": {"high_caution": 1000, "high_danger": 2000},
    "pm25": {"high_caution": 35, "high_danger": 75},
    "voc": {"high_caution": 1, "high_danger": 2},
}

GAP_SEC = 300          # 이 이상 기록이 끊기면 '데이터 공백'
BASELINE_MIN = 60      # 통계적 이상 탐지 기준 구간(분)
Z_CAUTION, Z_DANGER = 5.0, 8.0
MIN_FORECAST_SPAN = 300  # 예측에 필요한 최소 데이터 구간(초)
STALE_SEC = 60         # 마지막 수신 후 이 시간이 지나면 '수신 지연'

LEVEL_RANK = {"good": 0, "caution": 1, "danger": 2}


def level_of(key, v):
    if v is None:
        return None
    th = THRESHOLDS[META[key]["group"]]
    if "high_danger" in th and v > th["high_danger"]:
        return "danger"
    if "low_danger" in th and v < th["low_danger"]:
        return "danger"
    if "high_caution" in th and v > th["high_caution"]:
        return "caution"
    if "low_caution" in th and v < th["low_caution"]:
        return "caution"
    return "good"


def _f(s):
    if s is None or s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _mean(xs):
    return sum(xs) / len(xs) if xs else None


def _r(v, n=2):
    return None if v is None else round(v, n)


# ---------------------------------------------------------------------------
# 데이터 저장소 (파일 변경 시 증분 로딩)
# ---------------------------------------------------------------------------

class DataStore:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self._reset()

    def _reset(self):
        self.t = []                       # epoch seconds (로컬 시간 기준)
        self.v = {k: [] for k in KEYS}    # 원시값 (빈 값은 None)
        self.fault = []                   # AM 센서 0.0/99.0 고장 패턴 여부
        self.missing = 0
        self.offset = 0
        self.header = None
        self.version = 0
        self._cache = {}

    def refresh(self):
        """파일이 커졌으면 추가된 줄만 읽고, 줄어들었으면 전체 재로딩."""
        with self.lock:
            try:
                size = os.path.getsize(self.path)
            except OSError:
                return
            if size < self.offset:
                self._reset()
            if size == self.offset:
                return
            with open(self.path, "r", encoding="utf-8", newline="") as fp:
                fp.seek(self.offset)
                chunk = fp.read()
            # 마지막 줄이 쓰는 중일 수 있으므로 완성된 줄까지만 처리
            end = chunk.rfind("\n")
            if end < 0:
                return
            complete = chunk[: end + 1]
            self.offset += len(complete.encode("utf-8"))
            lines = complete.splitlines()
            if self.header is None and lines:
                self.header = next(csv.reader([lines[0]]))
                lines = lines[1:]
            idx = {name: i for i, name in enumerate(self.header)}
            added = 0
            for row in csv.reader(lines):
                if not row:
                    continue
                try:
                    ts = time.mktime(datetime.strptime(row[idx["timestamp"]], "%Y-%m-%d %H:%M:%S").timetuple())
                except (ValueError, KeyError, IndexError):
                    continue
                vals = {}
                for k in KEYS:
                    i = idx.get(k)
                    vals[k] = _f(row[i]) if i is not None and i < len(row) else None
                    if vals[k] is None:
                        self.missing += 1
                fault = vals["am_temp_C"] == 0.0 and vals["am_humi_pct"] == 99.0
                if fault:
                    vals["am_temp_C"] = vals["am_humi_pct"] = None
                self.t.append(ts)
                for k in KEYS:
                    self.v[k].append(vals[k])
                self.fault.append(fault)
                added += 1
            if added:
                self.version += 1
                self._cache = {}

    def cached(self, name, fn):
        key = (name, self.version)
        if key not in self._cache:
            self._cache[key] = fn()
        return self._cache[key]

    # -- 집계 ---------------------------------------------------------------

    def bucketize(self, start, end, bucket):
        """[start, end) 구간을 bucket 초 단위로 평균/최소/최대 집계. 빈 구간은 None."""
        i0 = bisect.bisect_left(self.t, start)
        i1 = bisect.bisect_left(self.t, end)
        n = max(1, int(math.ceil((end - start) / bucket)))
        acc = {k: [None] * n for k in KEYS}
        for i in range(i0, i1):
            b = int((self.t[i] - start) // bucket)
            if b >= n:
                continue
            for k in KEYS:
                x = self.v[k][i]
                if x is None:
                    continue
                a = acc[k][b]
                if a is None:
                    acc[k][b] = [x, 1, x, x]
                else:
                    a[0] += x
                    a[1] += 1
                    if x < a[2]:
                        a[2] = x
                    if x > a[3]:
                        a[3] = x
        times = [start + bucket * j for j in range(n)]
        out = {}
        for k in KEYS:
            mean, mn, mx = [], [], []
            for a in acc[k]:
                if a is None:
                    mean.append(None); mn.append(None); mx.append(None)
                else:
                    mean.append(a[0] / a[1]); mn.append(a[2]); mx.append(a[3])
            out[k] = {"mean": mean, "min": mn, "max": mx}
        return times, out

    def minutes(self):
        """전체 데이터를 1분 평균으로 집계 (이상 탐지·추이 분석 공통 입력)."""
        def build():
            if not self.t:
                return [], {k: [] for k in KEYS}
            start = self.t[0] - (self.t[0] % 60)
            times, agg = self.bucketize(start, self.t[-1] + 60, 60)
            return times, {k: agg[k]["mean"] for k in KEYS}
        return self.cached("minutes", build)


# ---------------------------------------------------------------------------
# 이상 탐지
# ---------------------------------------------------------------------------

def _episodes(flags, times, max_gap=2):
    """flags: 분 인덱스 -> (severity, value, score). 연속 구간을 하나의 이벤트로 병합."""
    eps = []
    cur = None
    for i in sorted(flags):
        sev, val, score = flags[i]
        if cur and i - cur["end_i"] <= max_gap + 1:
            cur["end_i"] = i
            cur["n"] += 1
            if LEVEL_RANK[sev] > LEVEL_RANK[cur["severity"]]:
                cur["severity"] = sev
            if abs(score) > abs(cur["score"]):
                cur["score"], cur["peak"] = score, val
        else:
            if cur:
                eps.append(cur)
            cur = {"start_i": i, "end_i": i, "n": 1, "severity": sev, "peak": val, "score": score}
    if cur:
        eps.append(cur)
    for e in eps:
        e["start"] = times[e.pop("start_i")]
        e["end"] = times[e.pop("end_i")] + 60
    return eps


def detect_anomalies(store):
    def build():
        times, mins = store.minutes()
        events = []

        # 1) 데이터 공백
        t = store.t
        for i in range(1, len(t)):
            if t[i] - t[i - 1] > GAP_SEC:
                events.append({"kind": "sensor", "type": "gap", "metric": None, "start": t[i - 1], "end": t[i],
                               "severity": "caution", "peak": None, "score": None,
                               "desc": f"데이터 수신 공백 {_fmt_dur(t[i] - t[i - 1])}"})

        # 2) AM 센서 고장 패턴 (0.0°C / 99.0%)
        fault_flags = {}
        if store.t:
            start = times[0] if times else 0
            for i, f in enumerate(store.fault):
                if f:
                    fault_flags[int((store.t[i] - start) // 60)] = ("caution", None, 0)
        for e in _episodes(fault_flags, times, max_gap=5):
            if e["n"] >= 2:
                e.update(kind="sensor", type="fault", metric="am_temp_C",
                         desc="AM 센서 고장 패턴 (0.0°C / 99.0% 고정 출력)")
                events.append(e)

        for m in METRICS:
            k = m["key"]
            series = mins[k]

            # 3) 값 고정 (flatline): 원시값이 장시간 완전히 동일
            if m["flat_min"]:
                vals, ts = store.v[k], store.t
                run_start = run_last = None   # 빈 값(None)은 구간을 끊지 않음
                for i in range(len(vals) + 1):
                    x = vals[i] if i < len(vals) else None
                    if i < len(vals) and x is None:
                        continue
                    if run_start is not None and (i == len(vals) or x != vals[run_start]
                                                  or ts[i] - ts[run_last] > GAP_SEC):
                        dur = ts[run_last] - ts[run_start]
                        if dur >= m["flat_min"] * 60:
                            events.append({"kind": "sensor", "type": "flatline", "metric": k,
                                           "start": ts[run_start], "end": ts[run_last], "severity": "caution",
                                           "peak": vals[run_start], "score": None,
                                           "desc": f"{m['label']} 값이 {_fmt_dur(dur)} 동안 {vals[run_start]:g}{m['unit']}로 고정"})
                        run_start = None
                    if i < len(vals):
                        if run_start is None:
                            run_start = i
                        run_last = i

            # 4) 기준치 초과 (환경 이상)
            flags = {}
            for i, x in enumerate(series):
                lv = level_of(k, x)
                if lv in ("caution", "danger"):
                    flags[i] = (lv, x, _excess(k, x))
            for e in _episodes(flags, times, max_gap=5):
                e.update(kind="env", type="threshold", metric=k,
                         desc=(f"{m['label']} 기준 초과 (최고 {e['peak']:.1f}{m['unit']})" if _is_high(k, e["peak"])
                              else f"{m['label']} 기준 미달 (최저 {e['peak']:.1f}{m['unit']})"))
                events.append(e)

            # 5) 급변 (직전 60분 대비 robust z-score)
            flags = {}
            window = []
            last_i = None
            for i, x in enumerate(series):
                if x is None:
                    continue
                # 10분 넘게 끊겼다면 이전 기준 구간은 폐기
                if last_i is not None and i - last_i > 10:
                    window = []
                last_i = i
                if len(window) >= 15:
                    med = statistics.median(window)
                    mad = statistics.median([abs(w - med) for w in window]) * 1.4826
                    scale = max(mad, m["min_scale"])
                    z = (x - med) / scale
                    if abs(z) >= Z_CAUTION and abs(x - med) >= m["min_delta"]:
                        flags[i] = ("danger" if abs(z) >= Z_DANGER else "caution", x, z)
                window.append(x)
                if len(window) > BASELINE_MIN:
                    window.pop(0)
            for e in _episodes(flags, times):
                up = e["score"] > 0
                e.update(kind="env", type="spike" if up else "drop", metric=k,
                         desc=f"{m['label']} 급{'상승' if up else '하강'} (최대 {e['peak']:.1f}{m['unit']}, z={e['score']:.1f})")
                events.append(e)

        for e in events:
            e.pop("n", None)
            e["score"] = _r(e.get("score"), 1)
            e["peak"] = _r(e.get("peak"), 1)
            e["label"] = META[e["metric"]]["label"] if e.get("metric") else "데이터"
        events.sort(key=lambda e: e["start"], reverse=True)
        return events

    return store.cached("anomalies", build)



def _excess(k, v):
    """임계값을 벗어난 정도 (클수록 심각)."""
    th = THRESHOLDS[META[k]["group"]]
    if "high_caution" in th and v > th["high_caution"]:
        return v - th["high_caution"]
    if "low_caution" in th and v < th["low_caution"]:
        return th["low_caution"] - v
    return 0.0


def _is_high(k, v):
    th = THRESHOLDS[META[k]["group"]]
    return "high_caution" in th and v > th["high_caution"]


def _fmt_dur(sec):
    sec = int(sec)
    d, h, m = sec // 86400, sec % 86400 // 3600, sec % 3600 // 60
    if d:
        return f"{d}일 {h}시간"
    if h:
        return f"{h}시간 {m}분"
    return f"{m}분 {sec % 60}초" if m < 5 else f"{m}분"


# ---------------------------------------------------------------------------
# API 응답 생성
# ---------------------------------------------------------------------------

def config():
    return {"metrics": METRICS, "primary": PRIMARY, "thresholds": THRESHOLDS, "stale_sec": STALE_SEC}


def current(store):
    if not store.t:
        return {"empty": True}
    n = len(store.t)
    last_t = store.t[-1]
    out = {"time": last_t, "age_sec": time.time() - last_t, "stale": time.time() - last_t > STALE_SEC,
           "metrics": {}}
    # 10분 전 값과 비교 (공백 직후라면 확보된 가장 오래된 값과 비교하고 실제 경과 시간을 함께 반환)
    ref_i = max(0, bisect.bisect_left(store.t, last_t - 600))
    out["delta_sec"] = last_t - store.t[ref_i]
    for k in KEYS:
        # 최신 유효값 (최근 1분 내)
        val = None
        for i in range(n - 1, max(-1, n - 120), -1):
            if store.v[k][i] is not None and last_t - store.t[i] <= 60:
                val = store.v[k][i]
                break
        ref = store.v[k][ref_i]
        out["metrics"][k] = {
            "value": val,
            "level": level_of(k, val),
            "delta": None if val is None or ref is None or store.t[ref_i] >= last_t else val - ref,
            "ok": val is not None,
        }
    return out


def series(store, start=None, end=None, max_points=700):
    if not store.t:
        return {"t": [], "bucket": 0, "metrics": {}}
    start = store.t[0] if start is None else max(start, store.t[0])
    end = store.t[-1] + 1 if end is None else min(end, store.t[-1] + 1)
    if end <= start:
        end = start + 60
    span = end - start
    steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400]
    bucket = next((s for s in steps if span / s <= max_points), steps[-1])
    start -= start % bucket
    times, agg = store.bucketize(start, end, bucket)
    rnd = {k: (1 if META[k]["group"] in ("temp", "humi") else 2) for k in KEYS}
    return {
        "t": [int(x * 1000) for x in times],
        "bucket": bucket,
        "metrics": {k: {s: [_r(x, rnd[k] + 1) for x in agg[k][s]] for s in ("mean", "min", "max")} for k in KEYS},
    }


def anomalies(store, start=None, end=None):
    evs = detect_anomalies(store)
    if start is not None:
        evs = [e for e in evs if e["end"] >= start]
    if end is not None:
        evs = [e for e in evs if e["start"] <= end]
    out = []
    for e in evs:
        d = dict(e)
        d["start"] = int(d["start"] * 1000)
        d["end"] = int(d["end"] * 1000)
        out.append(d)
    counts = defaultdict(int)
    for e in out:
        counts[e["kind"]] += 1
    return {"events": out, "counts": counts}


def trend(store, window_min=60):
    """최근 window_min 분의 원시 샘플에 선형회귀 → 시간당 변화율, 30분 후 예측, 임계 도달 예상.

    데이터가 공백 직후 재개된 경우 실제로 확보된 구간(span_sec)이 짧을 수 있으므로 함께 반환한다.
    """
    if not store.t:
        return {"metrics": {}}
    last = store.t[-1]
    lo = bisect.bisect_left(store.t, last - window_min * 60)
    # 공백 이후 구간만 사용
    for i in range(len(store.t) - 1, lo, -1):
        if store.t[i] - store.t[i - 1] > GAP_SEC:
            lo = i
            break
    res = {}
    for k in KEYS:
        pts = [((store.t[i] - last) / 3600.0, store.v[k][i]) for i in range(lo, len(store.t))
               if store.v[k][i] is not None]
        if len(pts) < 10 or (pts[-1][0] - pts[0][0]) * 3600 < 20:
            res[k] = None
            continue
        xs, ys = zip(*pts)
        mx, my = _mean(xs), _mean(ys)
        sxx = sum((x - mx) ** 2 for x in xs)
        sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
        syy = sum((y - my) ** 2 for y in ys)
        slope = sxy / sxx if sxx else 0.0
        r2 = (sxy * sxy) / (sxx * syy) if sxx and syy else 0.0
        cur = _mean(ys[-5:])
        span_sec = (xs[-1] - xs[0]) * 3600
        reliable = span_sec >= MIN_FORECAST_SPAN
        forecast = max(0.0, cur + slope * 0.5) if reliable else None
        eta = None
        th = THRESHOLDS[META[k]["group"]]
        if reliable and abs(slope) > 1e-9:
            cands = [(tv - cur) / slope for tv in th.values() if (tv - cur) / slope > 0]
            if cands and min(cands) <= 12:
                h = min(cands)
                eta = {"hours": round(h, 2), "target": round(cur + slope * h, 1)}
        res[k] = {
            "slope_per_h": round(slope, 3),
            "r2": round(r2, 3),
            "current": round(cur, 2),
            "forecast_30m": _r(forecast),
            "forecast_level": level_of(k, forecast),
            "eta": eta,
            "mean": round(my, 2),
            "min": round(min(ys), 2),
            "max": round(max(ys), 2),
            "n": len(ys),
            "span_sec": round(span_sec),
            "reliable": reliable,
        }
    return {"window_min": window_min, "end": int(last * 1000), "metrics": res}


def profile(store):
    """시간대(0~23시)별 평균 및 일자별 요약."""
    def build():
        times, mins = store.minutes()
        hours = {k: [[] for _ in range(24)] for k in KEYS}
        days = defaultdict(lambda: {k: [] for k in KEYS})
        for i, t in enumerate(times):
            lt = time.localtime(t)
            dkey = time.strftime("%Y-%m-%d", lt)
            for k in KEYS:
                x = mins[k][i]
                if x is not None:
                    hours[k][lt.tm_hour].append(x)
                    days[dkey][k].append(x)
        evs = detect_anomalies(store)
        ev_by_day = defaultdict(lambda: {"env": 0, "sensor": 0})
        for e in evs:
            ev_by_day[time.strftime("%Y-%m-%d", time.localtime(e["start"]))][e["kind"]] += 1
        daily = []
        for d in sorted(days):
            row = {"date": d, "minutes": max(len(v) for v in days[d].values()), "anomalies": ev_by_day[d], "metrics": {}}
            for k in KEYS:
                xs = days[d][k]
                row["metrics"][k] = None if not xs else {"min": _r(min(xs)), "mean": _r(_mean(xs)), "max": _r(max(xs))}
            daily.append(row)
        return {
            "hourly": {k: [_r(_mean(h)) for h in hours[k]] for k in KEYS},
            "daily": daily,
        }
    return store.cached("profile", build)


def health(store):
    n = len(store.t)
    if not n:
        return {}
    gaps = sum(1 for i in range(1, n) if store.t[i] - store.t[i - 1] > GAP_SEC)
    fault = sum(store.fault)
    span = store.t[-1] - store.t[0]
    gap_sec = sum(store.t[i] - store.t[i - 1] for i in range(1, n) if store.t[i] - store.t[i - 1] > GAP_SEC)
    return {
        "rows": n,
        "first": int(store.t[0] * 1000),
        "last": int(store.t[-1] * 1000),
        "missing_values": store.missing,
        "am_fault_pct": round(100.0 * fault / n, 2),
        "gaps": gaps,
        "coverage_pct": round(100.0 * (span - gap_sec) / span, 1) if span else 100.0,
    }
