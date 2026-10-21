"""Reproducible synthetic UTC resource-index control; no database or college data."""
import argparse
from datetime import date, timedelta
import json
from pathlib import Path
import platform
import threading
from time import perf_counter
import tracemalloc

import psutil

from backend.app.domain.publication import shared_conflicts


def events(count, start_date):
    result = []
    for index in range(count):
        group, ordinal = index % 20, index // 20
        start = 8 * 60 + ordinal % 5 * 90
        result.append({"id": f"SYNTHETIC-{start_date}-{index}", "date": (start_date + timedelta(days=ordinal // 5)).isoformat(),
            "start": f"{start // 60:02}:{start % 60:02}", "end": f"{(start + 90) // 60:02}:{(start + 90) % 60:02}", "cancelled": False,
            **{kind + "_id": f"SYNTHETIC-{kind}-{group}" for kind in ("teacher", "group", "room")},
            **{kind: f"SYNTHETIC {kind} {group}" for kind in ("teacher", "group", "room")}})
    return result


def benchmark():
    old, new = events(20000, date(2026,9,1)), events(1000, date(2027,4,1))
    publications = [{"timezone":"Asia/Almaty", "events":[e for e in old if e["group_id"] == f"SYNTHETIC-group-{group}"]} for group in range(20)]
    plain_started = perf_counter()
    plain_conflicts, plain_truncated = shared_conflicts(new,"Asia/Almaty",publications)
    plain_elapsed = perf_counter()-plain_started
    assert not plain_conflicts and not plain_truncated
    process = psutil.Process()
    peak = [process.memory_info().rss]
    stop = threading.Event()
    def sample():
        while not stop.wait(0.01): peak[0] = max(peak[0],process.memory_info().rss)
    sampler = threading.Thread(target=sample,daemon=True); sampler.start()
    tracemalloc.start(); started = perf_counter()
    try:
        conflicts, truncated = shared_conflicts(new,"Asia/Almaty",publications)
        elapsed = perf_counter()-started
        _, allocation_peak = tracemalloc.get_traced_memory()
        peak[0] = max(peak[0],process.memory_info().rss)
    finally:
        tracemalloc.stop(); stop.set(); sampler.join()
    assert not conflicts and not truncated
    # A half-open boundary is also exercised with exactly adjacent events.
    adjacent = {**new[0],"start":new[0]["end"],"end":"11:00"}
    boundary, cut = shared_conflicts([adjacent],"Asia/Almaty",[{"timezone":"Asia/Almaty","events":[new[0]]}])
    assert not boundary and not cut
    return {"control":"SYNTHETIC engineering resource-index control; not college capacity acceptance",
        "layer":"pure UTC resource index; excludes HTTP, SQL and full snapshot JSON loading",
        "platform":platform.platform(),"python":platform.python_version(),"logical_cpus":psutil.cpu_count(),
        "ram_bytes":psutil.virtual_memory().total,"active_snapshots":20,"registry_events":len(old),"candidate_events":len(new),
        "checked_resource_types":["teacher","group","room"],"elapsed_seconds_without_allocation_tracking":round(plain_elapsed,6),
        "elapsed_seconds_with_allocation_tracking":round(elapsed,6),
        "sample_interval_seconds":0.01,"sampled_process_peak_rss_bytes":peak[0],"index_python_allocation_peak_bytes":allocation_peak,
        "conflicts":len(conflicts),"truncated":truncated,"half_open_boundary_passed":True}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path);args=parser.parse_args()
    result=benchmark();content=json.dumps(result,ensure_ascii=False,indent=2)
    if args.output: args.output.write_text(content+'\n',encoding='utf-8')
    print(content)


if __name__ == '__main__': main()
