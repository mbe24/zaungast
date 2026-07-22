//! Differential-harness dumper (copy-reuse layer). Proves the cache-reusing snapshot loader
//! (`load_snapshot_reuse`) is byte-identical to a full cold read — for BOTH a cold cache (the first
//! tick, which parses + populates) and a warm cache (later ticks that REUSE the cached `.ldb`
//! parses). If the warm report ever diverged from the full read, a cached parse would be serving
//! stale/wrong bytes; asserting COLD == WARM == FULL closes that. On an unchanged dir neither reuse
//! pass may report `compacted`. The bin then emits the WARM report in the exact `diffsnap` format, so
//! the SAME TS oracle (harness/diff-snapshot.mjs) additionally proves warm-reuse (Rust) == full (TS)
//! — the snapshot layer already proves Rust-full == TS-full, so this closes the transitive chain.
//!   cargo run --bin diffreuse -- <leveldb-dir>
use libzaungast_native::idb::{load_snapshot, load_snapshot_reuse, snapshot_report, LdbCache};

fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("usage: diffreuse <leveldb-dir>");
    let full = snapshot_report(&load_snapshot(&dir).expect("load_snapshot"));

    let mut cache = LdbCache::new();
    assert!(
        !cache.has_prefix(),
        "cache must start with no folded prefix"
    );
    let (cold_snap, cold_compacted) = load_snapshot_reuse(&dir, &mut cache).expect("reuse (cold)");
    let cold = snapshot_report(&cold_snap);
    let built = cache.has_prefix(); // cold builds the folded prefix
    let cold_reused = cache.prefix_records_reused(); // 0 after a cold build (nothing reused yet)
    let (warm_snap, warm_compacted) = load_snapshot_reuse(&dir, &mut cache).expect("reuse (warm)");
    let warm = snapshot_report(&warm_snap);
    let warm_reused = cache.prefix_records_reused(); // warm must take the fast path → reuse the prefix

    // Intra-Rust invariants (fail loudly → the harness sees no valid stdout and reports failure).
    let mut bad = Vec::new();
    if cold_compacted {
        bad.push("cold pass falsely flagged compacted".to_string());
    }
    if warm_compacted {
        bad.push("warm pass falsely flagged compacted".to_string());
    }
    if !built {
        bad.push("cold pass built no folded prefix (expected one)".to_string());
    }
    // Perf guard: prove the warm pass took the clone-and-`.log`-only FAST PATH (a regression to a full
    // re-fold every tick would leave `prefix_records_reused` unchanged, yet every report still matches).
    if warm_reused <= cold_reused {
        bad.push(format!(
            "warm pass reused {warm_reused} prefix records (cold {cold_reused}) — fast path did not run"
        ));
    }
    if cold != full {
        bad.push("COLD reuse report != FULL report".to_string());
    }
    if warm != full {
        bad.push("WARM reuse report != FULL report".to_string());
    }
    if !bad.is_empty() {
        eprintln!("diffreuse FAIL:\n  - {}", bad.join("\n  - "));
        std::process::exit(1);
    }
    eprintln!(
        "diffreuse: COLD == WARM == FULL ok (prefix built, warm reused {warm_reused} records)"
    );

    // Emit the WARM (cache-reusing) report for the TS oracle (diff-snapshot.mjs) to match vs TS-full.
    print!("{warm}");
}
