//! Snappy raw-block decompressor — a faithful, dependency-free port of
//! `packages/libzaungast/src/format/chromium/snappy.ts` (standard Snappy raw-block format, NOT the
//! framed format). Hand-ported (rather than a crate) so P1 stays pure-std with no build scripts, and
//! so byte-identity to the TS reader is line-for-line auditable + verified by the differential harness.
//!
//! Format: varint uncompressed-length, then elements:
//!   tag&3==0 literal:     len-1 in tag>>2 (or, if >=60, in the next (val-59) LE bytes)
//!   tag&3==1 copy 1-byte: len=((tag>>2)&7)+4 ; offset=((tag>>5)<<8)|next byte
//!   tag&3==2 copy 2-byte: len=(tag>>2)+1     ; offset=next 2 bytes LE
//!   tag&3==3 copy 4-byte: len=(tag>>2)+1     ; offset=next 4 bytes LE
//! Copies may overlap (offset<len): the byte-by-byte forward copy reproduces snappy's feed-forward
//! overlap semantics exactly. `Err(())` on any truncation/out-of-bounds (→ caller treats as lossy),
//! mirroring the TS reader's throw-and-catch.

pub fn uncompress(input: &[u8]) -> Result<Vec<u8>, ()> {
    let mut ip = 0usize;
    // uncompressed length (varint)
    let mut out_len: usize = 0;
    let mut shift: u32 = 0;
    loop {
        let c = *input.get(ip).ok_or(())?;
        ip += 1;
        out_len |= ((c & 0x7f) as usize) << shift;
        if c & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift >= 64 {
            return Err(());
        }
    }

    let mut out = vec![0u8; out_len];
    let mut op = 0usize;
    let n = input.len();

    while ip < n {
        let tag = input[ip];
        ip += 1;
        let ty = tag & 0x03;
        if ty == 0 {
            // literal
            let mut len = (tag >> 2) as usize;
            if len < 60 {
                len += 1;
            } else {
                let nbytes = len - 59;
                let mut l: usize = 0;
                for i in 0..nbytes {
                    l |= (*input.get(ip).ok_or(())? as usize) << (8 * i as u32);
                    ip += 1;
                }
                len = l + 1;
            }
            let src = input.get(ip..ip.checked_add(len).ok_or(())?).ok_or(())?;
            out.get_mut(op..op.checked_add(len).ok_or(())?)
                .ok_or(())?
                .copy_from_slice(src);
            ip += len;
            op += len;
        } else {
            let len: usize;
            let offset: usize;
            if ty == 1 {
                len = (((tag >> 2) & 0x07) as usize) + 4;
                let b = *input.get(ip).ok_or(())?;
                ip += 1;
                offset = (((tag >> 5) as usize) << 8) | b as usize;
            } else if ty == 2 {
                len = ((tag >> 2) as usize) + 1;
                let b = input.get(ip..ip + 2).ok_or(())?;
                offset = (b[0] as usize) | ((b[1] as usize) << 8);
                ip += 2;
            } else {
                len = ((tag >> 2) as usize) + 1;
                let b = input.get(ip..ip + 4).ok_or(())?;
                offset = (b[0] as usize)
                    | ((b[1] as usize) << 8)
                    | ((b[2] as usize) << 16)
                    | ((b[3] as usize) << 24);
                ip += 4;
            }
            if offset == 0 || offset > op {
                return Err(());
            }
            let src = op - offset;
            if op.checked_add(len).ok_or(())? > out_len {
                return Err(());
            }
            // feed-forward overlap copy (byte-by-byte reproduces snappy's overlap semantics exactly)
            for i in 0..len {
                out[op + i] = out[src + i];
            }
            op += len;
        }
    }
    if op != out_len {
        return Err(());
    }
    Ok(out)
}
