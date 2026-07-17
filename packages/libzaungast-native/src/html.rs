//! HTML message content → clean plain text — faithful port of util/text.ts::htmlToText. One combined
//! matcher (tags + numeric/named entities) with a replacer reproducing the TS passes exactly, then
//! whitespace normalization. Uses ASCII classes to match TS `\w`/`\d` (ASCII). Verified against the
//! TS output over the real message corpus by the `htmltext` differential.

use std::sync::OnceLock;

use regex::{Captures, Regex};

fn combined_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // <tag> | &#xHEX; | &#DEC; | &name;   (case-insensitive; ASCII word/hex classes like TS)
    RE.get_or_init(|| Regex::new(r"(?i)<[^>]+>|&#x[0-9a-f]+;|&#[0-9]+;|&[a-z0-9_]+;").unwrap())
}
fn ws_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[ \t]+").unwrap())
}
fn nl_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\n{3,}").unwrap())
}

fn entity_exact(m: &str) -> Option<&'static str> {
    Some(match m {
        "&nbsp;" => " ",
        "&amp;" => "&",
        "&lt;" => "<",
        "&gt;" => ">",
        "&quot;" => "\"",
        "&apos;" => "'",
        "&auml;" => "ä",
        "&ouml;" => "ö",
        "&uuml;" => "ü",
        "&szlig;" => "ß",
        "&Auml;" => "Ä",
        "&Ouml;" => "Ö",
        "&Uuml;" => "Ü",
        "&eacute;" => "é",
        "&egrave;" => "è",
        "&ecirc;" => "ê",
        "&agrave;" => "à",
        "&acirc;" => "â",
        "&ccedil;" => "ç",
        "&ntilde;" => "ñ",
        "&uacute;" => "ú",
        "&iacute;" => "í",
        "&oacute;" => "ó",
        "&aacute;" => "á",
        "&ldquo;" => "\"",
        "&rdquo;" => "\"",
        "&lsquo;" => "'",
        "&rsquo;" => "'",
        "&hellip;" => "…",
        "&mdash;" => "—",
        "&ndash;" => "–",
        "&euro;" => "€",
        _ => return None,
    })
}

// `<br>` / `<br/>` / `<br />` (whitespace then optional single slash) — mirrors /^<br\s*\/?>$/i.
fn is_br(lower: &str) -> bool {
    if !lower.starts_with("<br") || lower.len() < 4 {
        return false;
    }
    let inner = &lower[3..lower.len() - 1]; // between "<br" and ">"
    let t = inner.trim_start();
    t.is_empty() || t == "/"
}

pub fn html_to_text(html: &str) -> String {
    if html.is_empty() {
        return String::new();
    }
    let replaced = combined_re().replace_all(html, |caps: &Captures| -> String {
        let m = caps.get(0).unwrap().as_str();
        let b = m.as_bytes();
        if b[0] == b'<' {
            // a tag: div-open / </p> / <br> → newline; anything else stripped
            let lower = m.to_ascii_lowercase();
            if lower.starts_with("<div") || lower == "</p>" || is_br(&lower) {
                "\n".to_string()
            } else {
                String::new()
            }
        } else if b.len() > 1 && b[1] == b'#' {
            // numeric entity
            let x = b[2];
            let n = if x == b'x' || x == b'X' {
                i64::from_str_radix(&m[3..m.len() - 1], 16).ok()
            } else {
                m[2..m.len() - 1].parse::<i64>().ok()
            };
            n.and_then(|n| u32::try_from(n).ok())
                .and_then(char::from_u32)
                .map(|c| c.to_string())
                .unwrap_or_else(|| " ".to_string())
        } else {
            // named entity: exact, then lowercased, else a space
            entity_exact(m)
                .or_else(|| entity_exact(&m.to_lowercase()))
                .unwrap_or(" ")
                .to_string()
        }
    });
    let s = ws_re().replace_all(&replaced, " ");
    let s = nl_re().replace_all(&s, "\n\n");
    s.trim().to_string()
}
