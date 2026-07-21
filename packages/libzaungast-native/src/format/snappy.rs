//! Snappy raw-block decompression via the `snap` crate. Our TS `snappy.ts` hand-decodes the standard
//! Snappy raw-block format (varint uncompressed-length + literal/copy elements); `snap::raw::Decoder`
//! implements the identical format, so it yields byte-identical output for valid input — verified
//! against the TS reader by the sstable/snapshot/ssv differential harnesses.

/// Decompress a raw Snappy block (the bytes AFTER the sstable block's 5-byte trailer, or the value
/// wrapper's payload after `0xFF 0x11 0x02`), i.e. starting with the varint uncompressed-length.
pub fn uncompress(input: &[u8]) -> Result<Vec<u8>, snap::Error> {
    snap::raw::Decoder::new().decompress_vec(input)
}
