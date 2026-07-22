//! Wall-clock + peak-RSS profiler for the native ingest — the Rust twin of `scripts/profile.mjs`.
//! Emits a `timings.json` in the v1 schema (scripts/lib/timings-v1.mjs is the spec of record) so the
//! output lines up with the TS profiler and can be diffed by the compare tool. Phase-timing + RSS
//! data, NOT a flamegraph. Linux/WSL2 only (native build/run + `/proc`).
//!
//!   cargo run --release --features harness --bin profile -- \
//!       <leveldb-dir> <schema.sql> <mapping.json>... [--heavy | -n N] [--out DIR]
//!
//! Shared `metrics` use canonical names that MUST match the TS side (format.*, storeBuild.*,
//! fullParse.* [IN-MEMORY], throughput.*, refresh.noop.*, memory.*); native-only measurements
//! (the production to-disk ingest, the changed-tick component breakdown) go in `engineExtra`.
//!
//! Percentiles reuse the exact nearest-rank rule (`ceil(n·q)−1`, clamped) + population stddev the TS
//! `metric()` pins; stats are RAW (no rounding in the writer — the console/compare tool round). Peak
//! RSS follows the child-process protocol: a fresh `--cold`/`--cold-mem` child does ONE ingest and
//! reports its own `VmHWM` (a lifetime high-water mark, so it must be read from a single-op process).
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
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use libzaungast_native::fingerprint::fingerprint;
use libzaungast_native::idb::{
    load_snapshot, load_snapshot_capped, load_snapshot_reuse_timed, LdbCache,
};
use libzaungast_native::resolver::{
    entity_targets_for, extract_rows, load_mapping, select_mapping, store_set_from_fp,
};
use libzaungast_native::store::{
    build_store, build_store_timed, compute_state, ingest_to_file, refresh_store, refresh_to_file,
};

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

// Peak (VmHWM) / current (VmRSS) resident set, MB, straight from /proc — no crate, no unsafe. kB in
// the file → /1024 → MB, RAW (the schema forbids writer rounding). Linux only; None elsewhere.
fn proc_status_mb(key: &str) -> Option<f64> {
    let s = fs::read_to_string("/proc/self/status").ok()?;
    for line in s.lines() {
        if let Some(rest) = line.strip_prefix(key) {
            let kb = rest
                .split_whitespace()
                .find_map(|t| t.parse::<f64>().ok())?;
            return Some(kb / 1024.0);
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

// Run a command, return trimmed stdout (empty on any failure). Used for run provenance (git, date,
// rustc) — this bin is Linux/WSL only, so these are always present where it runs.
fn sh(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

// ---- bench: raw nearest-rank percentiles + population stddev, matching TS metric() exactly ----
struct Stat {
    n: usize,
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

fn stat(mut v: Vec<f64>) -> Stat {
    let n = v.len();
    v.sort_by(f64::total_cmp);
    let mean = v.iter().sum::<f64>() / n as f64;
    let var = v.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n as f64;
    // nearest-rank (ceil), clamped — identical to the TS metric()'s pc()
    let pc = |q: f64| {
        let idx = ((n as f64 * q).ceil() as usize)
            .saturating_sub(1)
            .min(n - 1);
        v[idx]
    };
    Stat {
        n,
        min: v[0],
        p50: pc(0.5),
        p75: pc(0.75),
        p90: pc(0.9),
        p95: pc(0.95),
        p99: pc(0.99),
        max: v[n - 1],
        mean,
        stddev: var.sqrt(),
    }
}

// A sampled metric in the v1 shape. n=1 collapses to `{ unit, n:1, value }` — the discriminator the
// TS side uses; consumers read `.value` when n===1 and the percentile fields otherwise.
fn metric_json(unit: &str, s: &Stat) -> Value {
    if s.n == 1 {
        return json!({ "unit": unit, "n": 1, "value": s.min });
    }
    json!({
        "unit": unit, "n": s.n, "min": s.min,
        "p50": s.p50, "p75": s.p75, "p90": s.p90, "p95": s.p95, "p99": s.p99,
        "max": s.max, "mean": s.mean, "stddev": s.stddev
    })
}

fn scalar_json(unit: &str, value: f64) -> Value {
    json!({ "unit": unit, "n": 1, "value": value })
}

fn bench(iters: usize, mut f: impl FnMut()) -> Stat {
    let mut v = Vec::with_capacity(iters);
    for _ in 0..iters {
        let t = Instant::now();
        f();
        v.push(ms(t.elapsed()));
    }
    stat(v)
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

// The `--cold` child: a fresh process does ONE production (to-disk) ingest, then reports its peak RSS.
// Because VmHWM never resets, this single-ingest process's high-water IS the disk-path cold peak.
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

// The `--cold-mem` child: one IN-MEMORY build_store, so its VmHWM is the peak of holding the store in
// RAM — the apples-to-apples memory number vs the TS engine (which keeps its store in memory). Its own
// process so the peak is this path's alone, not folded in with the disk-writing ingest.
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
        Some("--cold") => return run_cold(&args[2..]),
        Some("--cold-mem") => return run_cold_mem(&args[2..]),
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

    let mut metrics = Map::new();
    let mut extra = Map::new();

    // ---- 1. full parse, IN-MEMORY (the shared fullParse.*): load_snapshot + fingerprint + select +
    // build_store, with the snapshot RE-LOADED every iteration (that read is the dominant cost — reusing
    // a cached snapshot would drop it and be a false friend vs the TS profiler, which re-reads too).
    // Measured FIRST — before the cached snap0 below — so `cold` is genuinely the process's first
    // snapshot read (matches the TS profiler, whose cold ingest precedes its snap0). ----
    let inmem = || {
        let s = load_snapshot(dir).expect("load_snapshot");
        let fp = fingerprint(&s);
        let m = select_mapping(&fp.hash, &store_set_from_fp(&fp.stores), &mappings)
            .expect("no mapping matched");
        drop(build_store(&s, m, &schema));
    };
    let tc = Instant::now();
    inmem();
    let inmem_cold_ms = ms(tc.elapsed());
    let inmem_warm = bench(n, inmem);
    metrics.insert("fullParse.cold".into(), scalar_json("ms", inmem_cold_ms));
    metrics.insert("fullParse.warm".into(), metric_json("ms", &inmem_warm));

    // cached snapshot + mapping for the format / store-build / changed-tick benches below
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

    // throughput derived from the IN-MEMORY warm p50 (not the to-disk path).
    let warm_p50 = inmem_warm.p50;
    metrics.insert(
        "throughput.entries".into(),
        scalar_json("perSec", snap0.unique_count as f64 / (warm_p50 / 1000.0)),
    );
    metrics.insert(
        "throughput.bytes".into(),
        scalar_json(
            "MBperSec",
            parsed_bytes as f64 / 1_048_576.0 / (warm_p50 / 1000.0),
        ),
    );

    // ---- 2. format-layer phases (shared 1:1 with the TS format.*) ----
    let fmt_load = bench(n, || {
        std::hint::black_box(load_snapshot(dir).expect("load_snapshot"));
    });
    let fmt_load_p50 = fmt_load.p50; // reused as the changed-tick full-load basis
    metrics.insert("format.loadSnapshot".into(), metric_json("ms", &fmt_load));
    metrics.insert(
        "format.fingerprint".into(),
        metric_json(
            "ms",
            &bench(n, || {
                std::hint::black_box(fingerprint(&snap0));
            }),
        ),
    );
    metrics.insert(
        "format.entityTargets".into(),
        metric_json(
            "ms",
            &bench(n, || {
                std::hint::black_box(entity_targets_for(&snap0, mapping, "message"));
            }),
        ),
    );
    for ent in ["message", "conversation", "event", "call", "profile"] {
        metrics.insert(
            format!("format.extract.{ent}"),
            metric_json(
                "ms",
                &bench(n, || {
                    std::hint::black_box(extract_rows(&snap0, mapping, ent));
                }),
            ),
        );
    }

    // ---- 3. store-build phases (shared with the TS storeBuild.*) via build_store_timed. `total` is
    // native-only (TS emits no storeBuild.total) → engineExtra, not a one-sided canonical key. ----
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
    metrics.insert("storeBuild.extract".into(), metric_json("ms", &stat(ex)));
    metrics.insert("storeBuild.apply".into(), metric_json("ms", &stat(ap)));
    metrics.insert("storeBuild.recompute".into(), metric_json("ms", &stat(rc)));
    metrics.insert("storeBuild.fts".into(), metric_json("ms", &stat(ft)));
    extra.insert("storeBuild.total".into(), metric_json("ms", &stat(tot)));

    // in-memory build peak (own child) → the shared memory.storePeakRss (matches the TS cold child,
    // which also ingests into an in-memory store). The disk-path peak goes to engineExtra below.
    if let Some(p) = child_peak(
        "--cold-mem",
        "inMemoryBuildPeakRssMB",
        schema_path,
        dir,
        mapping_paths,
    ) {
        metrics.insert("memory.storePeakRss".into(), scalar_json("MB", p));
    }

    // ---- 4. incremental no-op refresh (copy prev → apply-nothing) → refresh.noop.fileRefresh. The
    // native engine has only this one file-based no-op mechanism; it pairs with neither TS no-op mode,
    // so the compare tool lists it in the "one engine only" section. ----
    let prev = env::temp_dir().join("zaungast-profile-prev.db");
    let newp = env::temp_dir().join("zaungast-profile-new.db");
    let (prev_s, new_s) = (prev.to_str().expect("temp"), newp.to_str().expect("temp"));
    ingest_to_file(dir, prev_s, &schema, &mappings_json).expect("prev ingest");
    let _ = refresh_to_file(dir, prev_s, new_s, &mappings_json); // warm the copy-reuse cache
    let inc = bench(inc_iters, || {
        refresh_to_file(dir, prev_s, new_s, &mappings_json).expect("refresh");
    });
    metrics.insert("refresh.noop.fileRefresh".into(), metric_json("ms", &inc));

    // ---- 5. production to-disk ingest (native's shipped path) → engineExtra.ingestToDisk.*. This is
    // NOT fullParse (that's the in-memory build above); the disk write is a native-only concern. ----
    let dest = env::temp_dir().join("zaungast-profile.db");
    let dest_s = dest.to_str().expect("temp path");
    let tc2 = Instant::now();
    let cold = ingest_to_file(dir, dest_s, &schema, &mappings_json).expect("cold ingest"); // + counts
    extra.insert(
        "ingestToDisk.cold".into(),
        scalar_json("ms", ms(tc2.elapsed())),
    );
    extra.insert(
        "ingestToDisk.warm".into(),
        metric_json(
            "ms",
            &bench(n, || {
                ingest_to_file(dir, dest_s, &schema, &mappings_json).expect("warm ingest");
            }),
        ),
    );
    if let Some(p) = child_peak("--cold", "coldPeakRssMB", schema_path, dir, mapping_paths) {
        extra.insert("ingestToDisk.coldPeakRss".into(), scalar_json("MB", p));
    }

    // ---- 6. changed-tick component breakdown → engineExtra.refresh.changed.* (each measured
    // INDEPENDENTLY; native has no end-to-end changed-tick bench, so these are not a shared metric). ----
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
    let copy_stat = bench(n, || {
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
    // cache-reusing snapshot load: warm once, then measure the warm reuse-load split into fold + collect.
    let mut reuse_cache = LdbCache::new();
    let _ = load_snapshot_reuse_timed(dir, &mut reuse_cache).expect("reuse warm-up");
    let (mut rl, mut rf, mut rcol) = (Vec::new(), Vec::new(), Vec::new());
    for _ in 0..n {
        let t = Instant::now();
        let (snap, _c, tm) = load_snapshot_reuse_timed(dir, &mut reuse_cache).expect("reuse load");
        rl.push(ms(t.elapsed()));
        rf.push(ms(tm.fold));
        rcol.push(ms(tm.collect));
        drop(snap);
    }
    extra.insert("refresh.changed.copy".into(), metric_json("ms", &copy_stat));
    extra.insert(
        "refresh.changed.deltaApply".into(),
        metric_json("ms", &stat(delta_ms)),
    );
    extra.insert(
        "refresh.changed.loadSnapshot".into(),
        scalar_json("ms", fmt_load_p50),
    );
    extra.insert(
        "refresh.changed.reuseLoad".into(),
        metric_json("ms", &stat(rl)),
    );
    extra.insert(
        "refresh.changed.reuseFold".into(),
        metric_json("ms", &stat(rf)),
    );
    extra.insert(
        "refresh.changed.reuseCollect".into(),
        metric_json("ms", &stat(rcol)),
    );
    extra.insert("refresh.changed.dbSizeBytes".into(), json!(db_size));
    extra.insert(
        "refresh.changed.changedRecords".into(),
        json!(changed_records),
    );
    extra.insert(
        "refresh.changed.reusePrefixRecords".into(),
        json!(reuse_cache.prefix_records_reused()),
    );

    // ---- envelope (v1) — engine "native", host.platform the OS token (NOT the kernel string, so the
    // compare tool's same-platform gate matches TS-on-WSL2), when ISO-8601, git provenance. ----
    let git_sha = sh("git", &["rev-parse", "HEAD"]);
    let git_dirty = !sh("git", &["status", "--porcelain"]).is_empty();
    let when = sh("date", &["-u", "+%Y-%m-%dT%H:%M:%SZ"]);
    let rustc = sh("rustc", &["--version"]);
    let hostname = fs::read_to_string("/proc/sys/kernel/hostname")
        .unwrap_or_default()
        .trim()
        .to_string();
    let results = json!({
        "schemaVersion": 1,
        "engine": "native",
        "when": when,
        "git": { "sha": git_sha, "dirty": git_dirty },
        "host": { "platform": env::consts::OS, "cpu": cpu_model(), "hostname": hostname },
        "runtime": format!("{} --release", if rustc.is_empty() { "rustc" } else { &rustc }),
        "dataset": {
            "dir": dir,
            "entries": snap0.unique_count,
            "bytes": parsed_bytes,
            "counts": { "conversations": cold.conversations, "messages": cold.messages, "people": cold.people },
            "fingerprint": fp0.hash,
            "lossy": cold.lossy
        },
        "mode": if heavy { "heavy" } else { "light" },
        "iters": { "full": n, "incremental": inc_iters },
        "metrics": Value::Object(metrics),
        "engineExtra": Value::Object(extra)
    });

    fs::create_dir_all(&out_dir).expect("mkdir --out");
    let out_path = Path::new(&out_dir).join("timings.json");
    fs::write(
        &out_path,
        serde_json::to_string_pretty(&results).expect("serialize"),
    )
    .expect("write timings.json");

    // ---- console summary (stderr): the same measurements read back from the envelope, rounded for
    // display (the JSON stays raw). n=1 metrics print their value; sampled ones print p50/p90/p99. ----
    let m = &results["metrics"];
    let e = &results["engineExtra"];
    let d3 = |x: f64| (x * 1000.0).round() / 1000.0;
    let show = |title: &str, keys: &[&str], from: &Value| {
        eprintln!("\n{title}:");
        for k in keys {
            let Some(v) = from.get(*k) else { continue };
            let line = if v.get("n").and_then(Value::as_u64) == Some(1) {
                format!(
                    "{} {}",
                    d3(v["value"].as_f64().unwrap_or(0.0)),
                    v["unit"].as_str().unwrap_or("")
                )
            } else {
                format!(
                    "p50 {:>9}  p90 {:>9}  p99 {:>9}  ±{} {}",
                    d3(v["p50"].as_f64().unwrap_or(0.0)),
                    d3(v["p90"].as_f64().unwrap_or(0.0)),
                    d3(v["p99"].as_f64().unwrap_or(0.0)),
                    d3(v["stddev"].as_f64().unwrap_or(0.0)),
                    v["unit"].as_str().unwrap_or("")
                )
            };
            eprintln!("  {k:<28} {line}");
        }
    };
    eprintln!("\n=== profile (native) → {} ===", out_path.display());
    eprintln!("data: {dir}");
    eprintln!(
        "  {} entries · {:.1} MB · counts {{conv {} msg {} ppl {}}} · lossy {} · fp {}",
        snap0.unique_count,
        parsed_bytes as f64 / 1_048_576.0,
        cold.conversations,
        cold.messages,
        cold.people,
        cold.lossy,
        fp0.hash
    );
    eprintln!(
        "  mode: {} (full N={n} · incremental {inc_iters})",
        if heavy { "heavy" } else { "light" }
    );
    show(
        "full parse (in-memory)",
        &[
            "fullParse.cold",
            "fullParse.warm",
            "memory.storePeakRss",
            "throughput.entries",
            "throughput.bytes",
        ],
        m,
    );
    show(
        "format phases",
        &[
            "format.loadSnapshot",
            "format.fingerprint",
            "format.entityTargets",
            "format.extract.message",
            "format.extract.conversation",
            "format.extract.event",
            "format.extract.call",
            "format.extract.profile",
        ],
        m,
    );
    show(
        "store-build phases",
        &[
            "storeBuild.extract",
            "storeBuild.apply",
            "storeBuild.recompute",
            "storeBuild.fts",
        ],
        m,
    );
    show(
        "incremental (no-op floor)",
        &["refresh.noop.fileRefresh"],
        m,
    );
    show(
        "engineExtra (native-only): to-disk ingest",
        &[
            "ingestToDisk.cold",
            "ingestToDisk.warm",
            "ingestToDisk.coldPeakRss",
        ],
        e,
    );
    show(
        "engineExtra: changed-tick components (independent)",
        &[
            "refresh.changed.copy",
            "refresh.changed.deltaApply",
            "refresh.changed.reuseLoad",
            "refresh.changed.reuseFold",
            "refresh.changed.reuseCollect",
        ],
        e,
    );
    eprintln!(
        "  changed records {} · db {:.1} MB · prefix records reused {}",
        changed_records,
        db_size as f64 / 1_048_576.0,
        reuse_cache.prefix_records_reused()
    );
    eprintln!("\nartifacts in {out_dir}: timings.json (v1)");
}
