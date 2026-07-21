//! Wall-clock + peak-RSS profiler for the native ingest — the Rust twin of `scripts/profile.mjs`.
//! Emits a `timings.json` in the SAME shape as the TS harness so the main session can author a
//! `profiling/<stamp>/profiling.md` for the native engine that's directly comparable to the TS ones.
//! Phase-timing + RSS data, NOT a flamegraph. Linux/WSL2 only (native build/run + `/proc`).
//!
//!   cargo run --release --features harness --bin profile -- \
//!       <leveldb-dir> <schema.sql> <mapping.json>... [--heavy | -n N] [--out DIR]
//!
//! Percentiles reuse `profile.mjs`'s exact nearest-rank rule (`ceil(n·q)−1`, clamped) + 3-decimal
//! rounding, so the tables line up. Peak RSS follows the same protocol: a fresh `--cold` child does
//! ONE ingest and reports its own `VmHWM` (a process-lifetime high-water mark that never resets, so it
//! must be read from a single-ingest process, not after the warm loop).
#![allow(
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_possible_truncation,
    clippy::too_many_lines
)]

use std::env;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use libzaungast_native::fingerprint::fingerprint;
use libzaungast_native::idb::{load_snapshot, load_snapshot_capped, load_snapshot_reuse, LdbCache};
use libzaungast_native::resolver::{
    entity_targets_for, extract_rows, load_mapping, select_mapping, store_set_from_fp,
};
use libzaungast_native::store::{
    build_store, build_store_timed, compute_state, ingest_to_file, refresh_store, refresh_to_file,
};

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}
fn r3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}
fn r1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

// Peak (VmHWM) / current (VmRSS) resident set, MB, straight from /proc — no crate, no unsafe. kB in
// the file → /1024 → MB. Linux only; None elsewhere (the caller emits null).
fn proc_status_mb(key: &str) -> Option<f64> {
    let s = fs::read_to_string("/proc/self/status").ok()?;
    for line in s.lines() {
        if let Some(rest) = line.strip_prefix(key) {
            let kb = rest
                .split_whitespace()
                .find_map(|t| t.parse::<f64>().ok())?;
            return Some(r1(kb / 1024.0));
        }
    }
    None
}

fn cpu_model() -> Option<String> {
    let s = fs::read_to_string("/proc/cpuinfo").ok()?;
    s.lines().find_map(|l| {
        l.strip_prefix("model name")
            .map(|r| r.trim_start_matches([':', ' ', '\t']).trim().to_string())
    })
}

// ---- bench: fixed-N, nearest-rank percentiles, matching profile.mjs's bench() exactly ----
struct Stat {
    label: String,
    iters: usize,
    min: f64,
    p50: f64,
    p75: f64,
    p90: f64,
    p95: f64,
    p99: f64,
    max: f64,
    mean: f64,
    stddev: f64,
}

fn stat(label: &str, mut v: Vec<f64>) -> Stat {
    let iters = v.len();
    v.sort_by(f64::total_cmp);
    let mean = v.iter().sum::<f64>() / iters as f64;
    let var = v.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / iters as f64;
    // nearest-rank (ceil), clamped — identical to profile.mjs's pc()
    let pc = |q: f64| {
        let idx = ((iters as f64 * q).ceil() as usize)
            .saturating_sub(1)
            .min(iters - 1);
        v[idx]
    };
    Stat {
        label: label.to_string(),
        iters,
        min: r3(v[0]),
        p50: r3(pc(0.5)),
        p75: r3(pc(0.75)),
        p90: r3(pc(0.9)),
        p95: r3(pc(0.95)),
        p99: r3(pc(0.99)),
        max: r3(v[iters - 1]),
        mean: r3(mean),
        stddev: r3(var.sqrt()),
    }
}

fn stat_json(s: &Stat) -> Value {
    json!({
        "label": s.label, "iters": s.iters, "min": s.min,
        "p50": s.p50, "median": s.p50, "p75": s.p75, "p90": s.p90, "p95": s.p95, "p99": s.p99,
        "max": s.max, "mean": s.mean, "stddev": s.stddev
    })
}

fn bench(label: &str, iters: usize, mut f: impl FnMut()) -> Stat {
    let mut v = Vec::with_capacity(iters);
    for _ in 0..iters {
        let t = Instant::now();
        f();
        v.push(ms(t.elapsed()));
    }
    stat(label, v)
}

fn read_inputs(dir: &str, schema_path: &str, mapping_paths: &[String]) -> (String, Vec<String>) {
    let schema = fs::read_to_string(schema_path).expect("read schema.sql");
    let mappings_json: Vec<String> = mapping_paths
        .iter()
        .map(|p| fs::read_to_string(p).expect("read mapping.json"))
        .collect();
    assert!(
        Path::new(dir).join("CURRENT").exists(),
        "not a leveldb dir (no CURRENT): {dir}"
    );
    (schema, mappings_json)
}

// The internal `--cold` child: a fresh process does ONE ingest, then reports its own peak RSS. Because
// VmHWM never resets, this single-ingest process's high-water IS the cold-parse peak.
fn run_cold(rest: &[String]) {
    let dir = &rest[0];
    let (schema, mappings_json) = read_inputs(dir, &rest[1], &rest[2..]);
    let dest = env::temp_dir().join("zaungast-profile-cold.db");
    ingest_to_file(
        dir,
        dest.to_str().expect("temp path"),
        &schema,
        &mappings_json,
    )
    .expect("cold ingest");
    println!("{}", json!({ "coldPeakRssMB": proc_status_mb("VmHWM:") }));
}

// The --cold-mem child: one IN-MEMORY build_store, so its VmHWM is the peak of holding the store in
// RAM. Non-production (the shipped path writes to disk) — it exists only to give the apples-to-apples
// memory number vs the TS engine, which keeps its store in memory. Its own process so VmHWM is this
// path's peak alone, not folded in with the disk-writing ingest.
fn run_cold_mem(rest: &[String]) {
    let dir = &rest[0];
    let (schema, _) = read_inputs(dir, &rest[1], &rest[2..]);
    let mappings: Vec<Value> = rest[2..]
        .iter()
        .map(|p| load_mapping(p).expect("parse mapping.json"))
        .collect();
    let snap = load_snapshot(dir).expect("load_snapshot");
    let fp = fingerprint(&snap);
    let mapping = select_mapping(&fp.hash, &store_set_from_fp(&fp.stores), &mappings)
        .expect("no mapping matched");
    let (conn, _timings) = build_store_timed(&snap, mapping, &schema);
    println!(
        "{}",
        json!({ "inMemoryBuildPeakRssMB": proc_status_mb("VmHWM:") })
    );
    drop(conn); // keep the store alive until the peak is read
}

// Spawn a fresh single-op child and read its reported peak. VmHWM never resets across a process, so a
// one-op child's high-water IS that op's peak — the only honest way to attribute peak RSS to a phase.
fn child_peak(
    mode: &str,
    key: &str,
    schema_path: &str,
    dir: &str,
    mapping_paths: &[String],
) -> Option<f64> {
    let exe = env::current_exe().ok()?;
    let mut cmd = Command::new(exe);
    cmd.arg(mode).arg(dir).arg(schema_path);
    for p in mapping_paths {
        cmd.arg(p);
    }
    let out = cmd.output().ok()?;
    let v: Value = serde_json::from_slice(&out.stdout).ok()?;
    v.get(key).and_then(Value::as_f64)
}

fn main() {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--cold") => {
            run_cold(&args[2..]);
            return;
        }
        Some("--cold-mem") => {
            run_cold_mem(&args[2..]);
            return;
        }
        _ => {}
    }

    // ---- args: <dir> <schema.sql> <mapping.json>... [--heavy | -n N] [--out DIR] ----
    let (mut positional, mut heavy, mut n_override, mut out_dir) =
        (Vec::<String>::new(), false, None::<usize>, ".".to_string());
    let mut it = args[1..].iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--heavy" => heavy = true,
            "-n" | "-N" => n_override = it.next().and_then(|s| s.parse().ok()),
            "--out" => {
                if let Some(o) = it.next() {
                    out_dir.clone_from(o);
                }
            }
            _ => positional.push(a.clone()),
        }
    }
    let dir = positional.first().expect(
        "usage: profile <leveldb-dir> <schema.sql> <mapping.json>... [--heavy|-n N] [--out DIR]",
    );
    let schema_path = positional.get(1).expect("schema.sql path required");
    let mapping_paths = &positional[2..];
    assert!(
        !mapping_paths.is_empty(),
        "at least one mapping.json required"
    );
    let n = n_override.unwrap_or(if heavy { 100 } else { 10 });
    let inc_iters = if heavy { 40 } else { 20 };

    let (schema, mappings_json) = read_inputs(dir, schema_path, mapping_paths);
    let mappings: Vec<Value> = mapping_paths
        .iter()
        .map(|p| load_mapping(p).expect("parse mapping.json"))
        .collect();

    // cached snapshot + selected mapping for the format-phase benches
    let snap0 = load_snapshot(dir).expect("load_snapshot");
    let fp0 = fingerprint(&snap0);
    let mapping = select_mapping(&fp0.hash, &store_set_from_fp(&fp0.stores), &mappings)
        .expect("no mapping matched this dir");

    let parsed_bytes: u64 = fs::read_dir(dir)
        .expect("read dir")
        .filter_map(Result::ok)
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|x| x.to_str())
                .is_some_and(|x| matches!(x.to_lowercase().as_str(), "ldb" | "log"))
        })
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum();

    // ---- 1. full parse (ingest to a temp file): cold 1× then warm N× ----
    let dest = env::temp_dir().join("zaungast-profile.db");
    let dest_s = dest.to_str().expect("temp path");
    let tc = Instant::now();
    let cold = ingest_to_file(dir, dest_s, &schema, &mappings_json).expect("cold ingest");
    let cold_ms = r3(ms(tc.elapsed()));
    let warm = bench("ingest (warm)", n, || {
        ingest_to_file(dir, dest_s, &schema, &mappings_json).expect("warm ingest");
    });

    // ---- 2. format-layer phase breakdown ----
    let mut format_phases = vec![
        bench("loadSnapshot (read+decode+group)", n, || {
            std::hint::black_box(load_snapshot(dir).expect("load_snapshot"));
        }),
        bench("fingerprint", n, || {
            std::hint::black_box(fingerprint(&snap0));
        }),
        bench("entityTargets (catalog lookup)", n, || {
            std::hint::black_box(entity_targets_for(&snap0, mapping, "message"));
        }),
    ];
    for ent in ["message", "conversation", "event", "call", "profile"] {
        format_phases.push(bench(&format!("extractEntity({ent})"), n, || {
            std::hint::black_box(extract_rows(&snap0, mapping, ent));
        }));
    }

    // ---- 3. store build (in-memory) — total + the fused sub-phases via build_store_timed ----
    let (mut tot, mut ex, mut ap, mut rc, mut ft) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for _ in 0..n {
        let t = Instant::now();
        let (conn, pt) = build_store_timed(&snap0, mapping, &schema);
        tot.push(ms(t.elapsed()));
        ex.push(ms(pt.extract));
        ap.push(ms(pt.apply));
        rc.push(ms(pt.recompute));
        ft.push(ms(pt.fts));
        drop(conn);
    }
    let store_total = stat("storeBuild (in-memory)", tot);
    let store_extract = stat("extract (5 entities)", ex);
    let store_apply = stat("apply (BEGIN..COMMIT)", ap);
    let store_recompute = stat("recompute_derived", rc);
    let store_fts = stat("refresh_fts", ft);
    // Non-production peak RSS of the in-memory build (own child) — the apples-to-apples memory number
    // vs the TS engine (both holding the store in RAM). The shipped path writes to disk; see coldPeak.
    let in_mem_peak = child_peak(
        "--cold-mem",
        "inMemoryBuildPeakRssMB",
        schema_path,
        dir,
        mapping_paths,
    );
    let store_build = json!({
        "total": stat_json(&store_total),
        "extract": stat_json(&store_extract),
        "apply": stat_json(&store_apply),
        "recompute": stat_json(&store_recompute),
        "fts": stat_json(&store_fts),
        "inMemoryBuildPeakRssMB": in_mem_peak,
    });

    // ---- 4. incremental no-op refresh (copy prev → apply-nothing) ----
    let prev = env::temp_dir().join("zaungast-profile-prev.db");
    let newp = env::temp_dir().join("zaungast-profile-new.db");
    let (prev_s, new_s) = (
        prev.to_str().expect("temp path"),
        newp.to_str().expect("temp path"),
    );
    ingest_to_file(dir, prev_s, &schema, &mappings_json).expect("prev ingest");
    let _ = refresh_to_file(dir, prev_s, new_s, &mappings_json); // warm the copy-reuse cache
    let inc = bench("incremental no-op refresh", inc_iters, || {
        refresh_to_file(dir, prev_s, new_s, &mappings_json).expect("refresh");
    });
    let mut inc_json = stat_json(&inc);
    inc_json["kind"] = json!("no-op");
    inc_json["mode"] = json!("native-refresh");

    // ---- 4b. CHANGED-tick refresh breakdown ----
    // A *changed* tick (unlike the R3-short-circuited no-op) pays: fs::copy(.db) + a full load_snapshot
    // (the `loadSnapshot` phase above, ~unchanged) + refresh_store(delta) + write_meta. Measure the copy
    // and the delta-apply here so we can choose the incremental path: ping-pong removes the COPY;
    // re-evaluating Axis B removes the full RE-READ. `refresh_store` is called directly (in-memory, as
    // diffincr does) — that bypasses refresh_to_file's R3 signature gate, which would short-circuit a
    // same-dir refresh.
    let store_db = env::temp_dir().join("zaungast-refresh-store.db");
    ingest_to_file(
        dir,
        store_db.to_str().expect("temp"),
        &schema,
        &mappings_json,
    )
    .expect("ingest");
    let db_size = fs::metadata(&store_db).map_or(0, |m| m.len());
    let copy_dst = env::temp_dir().join("zaungast-refresh-copy.db");
    let copy_stat = bench("fs::copy(.db)", n, || {
        let _ = fs::remove_file(&copy_dst);
        std::fs::copy(&store_db, &copy_dst).expect("copy");
    });
    // delta-apply for a small (~top 1% of sequences) changed delta, matching diffincr's mechanism.
    let mut seqs: Vec<u64> = snap0
        .buckets
        .iter()
        .flat_map(|b| b.records.iter().map(|r| r.seq))
        .collect();
    seqs.sort_unstable();
    let cap = seqs
        .get(seqs.len() * 99 / 100)
        .copied()
        .unwrap_or(snap0.max_seq);
    let capped = load_snapshot_capped(dir, cap).expect("load_snapshot_capped");
    let cap_state = compute_state(&capped, mapping);
    let changed_records = snap0
        .buckets
        .iter()
        .flat_map(|b| &b.records)
        .filter(|r| r.seq > cap_state.max_seq)
        .count();
    let mut delta_ms = Vec::new();
    for _ in 0..n {
        let prev = build_store(&capped, mapping, &schema); // fresh prev each iter (refresh mutates it)
        let t = Instant::now();
        refresh_store(&prev, &snap0, mapping, &cap_state);
        delta_ms.push(ms(t.elapsed()));
        drop(prev);
    }
    let delta_stat = stat("refresh_store (delta apply)", delta_ms);

    // Axis B copy-reuse load: warm the cache once (cold read populates it), then measure the WARM
    // reuse-load — the changed-tick READ cost AFTER Axis B (reuse cached immutable `.ldb`, re-read only
    // the `.log`) against the full `load_snapshot` above (formatPhases[0]). The Axis B changed tick ≈
    // reuseLoad(warm) + deltaApply + copy; the pre-Axis-B tick ≈ loadSnapshot(full) + deltaApply + copy.
    let mut reuse_cache = LdbCache::new();
    let _ = load_snapshot_reuse(dir, &mut reuse_cache).expect("reuse warm-up");
    let reuse_load = bench("loadSnapshotReuse (warm cache)", n, || {
        std::hint::black_box(load_snapshot_reuse(dir, &mut reuse_cache).expect("reuse load"));
    });
    let axis_b_tick = r3(reuse_load.p50 + delta_stat.p50 + copy_stat.p50);
    let full_read_tick = r3(format_phases[0].p50 + delta_stat.p50 + copy_stat.p50);
    let changed_refresh = json!({
        "note": "a CHANGED tick pays copy + loadSnapshot + deltaApply + write_meta; R3 short-circuits only NO-OP ticks. Axis B replaces the full loadSnapshot (formatPhases[0]) with reuseLoad (warm cache): tick ≈ reuseLoad + deltaApply + copy. deltaApply is then the tall pole (the ★b small-store-trim target).",
        "dbSizeBytes": db_size,
        "changedRecords": changed_records,
        "copy": stat_json(&copy_stat),
        "deltaApply": stat_json(&delta_stat),
        "loadSnapshotP50": format_phases[0].p50,
        "reuseLoad": stat_json(&reuse_load),
        "reuseHits": reuse_cache.hits(),
        "axisBChangedTickP50": axis_b_tick,
        "fullReadChangedTickP50": full_read_tick
    });

    // ---- 5. production peak RSS from a fresh single-ingest child (VmHWM protocol) ----
    let cold_peak = child_peak("--cold", "coldPeakRssMB", schema_path, dir, mapping_paths);

    // ---- meta + throughput ----
    let warm_p50 = warm.p50;
    let entries_per_sec = (snap0.unique_count as f64 / (warm_p50 / 1000.0)).round() as u64;
    let mb_per_sec = r1(parsed_bytes as f64 / 1_048_576.0 / (warm_p50 / 1000.0));
    let when_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let ostype = fs::read_to_string("/proc/sys/kernel/ostype").unwrap_or_default();
    let osrel = fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default();
    let platform = format!("{} {}", ostype.trim(), osrel.trim());

    let results = json!({
        "meta": {
            "whenUnixMs": when_ms,
            "dir": dir,
            "parsedBytes": parsed_bytes,
            "iterations": n,
            "mode": if heavy { "heavy" } else { "light" },
            "incIters": inc_iters,
            "engine": "native (rust)",
            "platform": platform.trim(),
            "cpu": cpu_model(),
            "counts": { "conversations": cold.conversations, "messages": cold.messages, "people": cold.people },
            "lossy": cold.lossy,
            "liveEntries": snap0.unique_count,
            "throughput": { "entriesPerSec": entries_per_sec, "mbPerSec": mb_per_sec }
        },
        "fullParse": {
            "coldMs": cold_ms,
            "warm": stat_json(&warm),
            "coldPeakRssMB": cold_peak
        },
        "formatPhases": format_phases.iter().map(stat_json).collect::<Vec<_>>(),
        "storeBuild": store_build,
        "incremental": [inc_json],
        "changedRefresh": changed_refresh
    });

    fs::create_dir_all(&out_dir).expect("mkdir --out");
    let out_path = Path::new(&out_dir).join("timings.json");
    fs::write(
        &out_path,
        serde_json::to_string_pretty(&results).expect("serialize"),
    )
    .expect("write timings.json");

    // ---- console summary (stderr), mirroring scripts/profile.mjs's layout ----
    // The disk-write split: `ingest_to_file` (shipped) writes+fsyncs the SQLite file; the TS-comparable
    // number is the in-memory pipeline (load + fingerprint + build). NEVER present the disk number bare
    // next to TS's in-memory ingest — they're different workloads.
    let load_p50 = format_phases[0].p50;
    let fp_p50 = format_phases[1].p50;
    let compute = load_p50 + fp_p50 + store_total.p50;
    let write = (warm.p50 - compute).max(0.0);
    let write_pct = (write / warm.p50 * 100.0).round();
    let mb = |o: Option<f64>| o.map_or_else(|| "—".to_string(), |v| v.to_string());
    let row = |s: &Stat| {
        format!(
            "  {:<44} p50 {:>8} p90 {:>8} p95 {:>8} p99 {:>8} ±{:>7}ms",
            s.label, s.p50, s.p90, s.p95, s.p99, s.stddev
        )
    };
    eprintln!("\n=== native profile → {} ===", out_path.display());
    eprintln!("data: {dir}");
    eprintln!(
        "  {} entries · {:.1} MB · counts {{conv {} msg {} ppl {}}} · lossy {}",
        snap0.unique_count,
        parsed_bytes as f64 / 1_048_576.0,
        cold.conversations,
        cold.messages,
        cold.people,
        cold.lossy
    );
    eprintln!(
        "  mode: {} (N={n} · incremental {inc_iters})",
        if heavy { "HEAVY" } else { "light" }
    );
    eprintln!();
    eprintln!(
        "full ingest → disk: cold {cold_ms}ms · warm p50 {}ms = compute ~{compute:.0}ms + file-write ~{write:.0}ms (~{write_pct:.0}%, fsync-per-stmt)",
        warm.p50
    );
    eprintln!(
        "  TS-comparable (in-memory build): {compute:.0}ms  [load {load_p50} + fp {fp_p50} + build {}]",
        store_total.p50
    );
    eprintln!("throughput (disk): {entries_per_sec} entries/s · {mb_per_sec} MB/s");
    eprintln!(
        "memory: cold peak {}MB (production) · in-mem build peak {}MB (non-production)",
        mb(cold_peak),
        mb(in_mem_peak)
    );
    eprintln!();
    eprintln!("format phases:");
    for s in &format_phases {
        eprintln!("{}", row(s));
    }
    eprintln!();
    eprintln!("store build (in-memory):");
    for s in [
        &store_extract,
        &store_apply,
        &store_recompute,
        &store_fts,
        &store_total,
    ] {
        eprintln!("{}", row(s));
    }
    eprintln!();
    eprintln!("incremental:");
    eprintln!("{}", row(&inc));
    eprintln!();
    eprintln!(
        "changed-tick components (a CHANGED refresh pays ALL of these; the no-op above is R3):"
    );
    eprintln!(
        "  db {:.1}MB · changed records {changed_records} · copy p50 {}ms · loadSnapshot p50 {}ms · reuseLoad p50 {}ms · deltaApply p50 {}ms",
        db_size as f64 / 1_048_576.0,
        copy_stat.p50,
        format_phases[0].p50,
        reuse_load.p50,
        delta_stat.p50
    );
    eprintln!(
        "  changed tick p50: full re-read {full_read_tick}ms  →  Axis B (copy-reuse) {axis_b_tick}ms  (deltaApply {}ms is now the tall pole → ★b)",
        delta_stat.p50
    );
    eprintln!();
    eprintln!("artifacts in {out_dir}: timings.json");
}
