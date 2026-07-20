# Terminal and font support for the proposed state-glyph set

**Question ([#21](https://github.com/elucidata/issues/issues/21), part of [#19](https://github.com/elucidata/issues/issues/19)):** how safe are `~ ⊘ ✓ » ×` as leading state indicators across the terminals, fonts, locales, and CI logs this CLI realistically runs in?

This is a **facts-gathering** document. It feeds the `--plain` contract; it does not decide it.

The proposed gutter (from #19) is six glyphs:

| Glyph | Codepoint | State |
|---|---|---|
| `-` | U+002D HYPHEN-MINUS | open |
| `~` | U+007E TILDE | open + claimed |
| `⊘` | U+2298 CIRCLED DIVISION SLASH | open + blocked |
| `✓` | U+2713 CHECK MARK | Completed |
| `»` | U+00BB RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK | Deferred |
| `×` | U+00D7 MULTIPLICATION SIGN | Won't Fix |

---

## Headline: the issue's stated risk model is inverted

#21 says "the new risk is concentrated in `»` and `×`", treating `⊘` as the proven-safe baseline because it ships today. **The measurements say the opposite on the axis that actually produces visible breakage.**

- **Font coverage** (the tofu axis): `»` and `×` are the *safest* non-ASCII characters of the six — universal, Latin-1, WGL4. `⊘` is the *least* covered character in the entire set, missing from Windows Terminal's default font, SF Mono, and Fira Code.
- **Width** (the alignment axis): `»`, `⊘`, `✓` are Unicode-Neutral. `×` is the **only** East_Asian_Width=Ambiguous character in the set — but no target terminal renders it wide by default, and two of the four *cannot* be made to.

So the two axes rank the characters in nearly opposite orders, and neither ranking matches the issue's premise.

**Consolidated across all evidence, the risk ordering is:**

1. **`⊘` — the only glyph with a genuine, measured problem.** Absent from Cascadia Mono, SF Mono and Fira Code; the terminal must font-fall-back to a proportional or CJK face, whose advance does not match the cell.
2. **`✓` — a residual legacy-font concern only.** Covered by every modern programming font; missing only from Monaco, Courier New, Andale Mono, PT Mono.
3. **`×` — one narrow, opt-in failure mode.** Renders two cells only if a user has deliberately enabled ambiguous-double-width in Terminal.app or iTerm2.
4. **`»`, `~`, `-` — no identified failure mode** in any environment examined.

The one risk that applies uniformly to all five non-ASCII glyphs is **downstream `wcwidth` under `LANG=C`** (§4), which is a piping concern, not a display concern.

Two facts from prior art (§5) bear directly on the `--plain` question: **gh ships `✓` U+2713 ungated** across Windows and CI with no fallback path at all, and the JS ecosystem's canonical fallback library (`figures`) degrades to **CP437, not ASCII** — using `×` U+00D7 as a *degradation target*. No modern CLI examined falls back to pure ASCII.

---

## 1. Unicode classification (primary source)

From [`EastAsianWidth.txt`](https://www.unicode.org/Public/UCD/latest/ucd/EastAsianWidth.txt) (`# EastAsianWidth-17.0.0.txt`, dated 2025-07-24), verbatim:

```
007E           ; Na # Sm         TILDE
00BB           ; N  # Pf         RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK
00D7           ; A  # Sm         MULTIPLICATION SIGN
2296..2298     ; N  # Sm     [3] CIRCLED MINUS..CIRCLED DIVISION SLASH
270C..2727     ; N  # So    [28] VICTORY HAND..WHITE FOUR POINTED STAR
```

| CP | Char | East_Asian_Width | gc | Block | In WGL4? |
|---|---|---|---|---|---|
| U+007E | `~` | **Na** Narrow | Sm | Basic Latin | yes |
| U+00BB | `»` | **N** Neutral | Pf | Latin-1 Supplement | yes |
| U+00D7 | `×` | **A** Ambiguous | Sm | Latin-1 Supplement | yes |
| U+2298 | `⊘` | **N** Neutral | Sm | Mathematical Operators | **no** |
| U+2713 | `✓` | **N** Neutral | So | Dingbats | **no** |

**Only `×` is Ambiguous.** This is stable history, not a recent reclassification: the values are identical in UCD 5.0.0, 9.0.0, 15.1.0 and 17.0.0. No UCD version back to 5.0 has ever given `»`, `⊘`, or `✓` anything other than `N`.

`»` being Neutral is deliberate, not incidental — the surrounding Latin-1 codepoints U+00B6..U+00BA and U+00BC..U+00BF are all `A`, and U+00BB is carved out between them as `N`.

Also confirmed: none of the five appears in [`emoji-data.txt`](https://www.unicode.org/Public/UCD/latest/ucd/emoji/emoji-data.txt). `✓` U+2713 is **not** Emoji and **not** Extended_Pictographic (its heavy cousins U+2714/U+2716 are). No emoji-presentation width promotion applies, and no risk of a color emoji font hijacking the glyph.

### What UAX #11 says Ambiguous means

[UAX #11](https://www.unicode.org/reports/tr11/) (Unicode 17.0.0, rev 44), §4 ED6:

> **East Asian Ambiguous (A)**: All characters that can be sometimes wide and sometimes narrow. Ambiguous characters require additional information not contained in the character code to further resolve their width.

§5 Recommendations, the load-bearing sentence:

> Ambiguous characters behave like wide or narrow characters depending on the context (language tag, script identification, associated font, source of data, or explicit markup; all can provide the context). **If the context cannot be established reliably, they should be treated as narrow characters by default.**

So `×` is narrow *by default and by recommendation*; it goes wide only where a terminal has been deliberately configured for CJK legacy compatibility.

**Important caveat cutting the other way** — §4.2 warns that Neutral is not a guarantee:

> many of the symbols in the Unicode Standard have no mappings to legacy character sets, yet they may be rendered as "wide" characters if they appear in an East Asian context. An implementation might therefore elect to treat them as ambiguous even though they are classified as neutral here.

That warning applies to `⊘` and `✓`. Neutral means *Unicode does not sanction* double-widthing them; it does not mean no terminal ever will.

### wcwidth reference implementation

Markus Kuhn's [`wcwidth.c`](https://www.cl.cam.ac.uk/~mgk25/ucs/wcwidth.c) (2007-05-26, Unicode 5.0) is the ancestor of most terminal width logic. `mk_wcwidth()` gives Ambiguous width 1:

> Choosing single-width for these characters is easy to justify as the appropriate long-term solution, as the CJK practice of displaying these characters as double-width comes from historic implementation simplicity […] and not any typographic considerations.

The opt-in `mk_wcwidth_cjk()` variant gives Ambiguous width 2, and its own comment discourages it:

> This variant might be useful for users of CJK legacy encodings who want to migrate to UCS without changing the traditional terminal character-width behaviour. **It is not otherwise recommended for general use.**

In that variant's `ambiguous[]` table: `{ 0x00D7, 0x00D8 }` is present → **`×` is width 2 under `wcwidth_cjk`**. `~`, `⊘`, `✓` are absent. `»` is absent *pointedly* — the table contains `{ 0x00B6, 0x00BA }` and `{ 0x00BC, 0x00BF }`, skipping exactly `0x00BB`.

Kuhn's own caveat about Neutral is worth recording, since three of our glyphs are Neutral:

> The following routines at present merely assign a single-cell width to all neutral characters, in the interest of simplicity. This is not entirely satisfactory and should be reconsidered before establishing a formal standard in this area.

---

## 2. Font coverage — measured, not assumed

I read the `cmap` tables directly out of the font binaries installed on a current macOS box (fontTools 4.56, `/System/Library/Fonts` + `Supplemental` + user fonts). `ok` = codepoint present in the font's own cmap; `MISS` = absent, so the terminal must fall back to another font or draw tofu.

Two independent passes were run — one over this machine's installed fonts, one over current upstream releases of the major programming fonts. Combined:

| font | `~` | `»` | `×` | `⊘` | `✓` | `…` |
|---|---|---|---|---|---|---|
| **Menlo** *(Terminal.app + iTerm2 default)* | ok | ok | ok | **ok** | ok | ok |
| **Cascadia Mono** *(Windows Terminal default)* | ok | ok | ok | **MISS** | ok | — |
| Cascadia Code | ok | ok | ok | **MISS** | ok | — |
| **SF Mono** (`.SF NS Mono`) | ok | ok | ok | **MISS** | ok | ok |
| Fira Code (all weights) | ok | ok | ok | **MISS** | ok | ok |
| FiraCode Nerd Font (all variants) | ok | ok | ok | **MISS** | ok | ok |
| DejaVu Sans Mono | ok | ok | ok | ok | ok | — |
| JetBrains Mono | ok | ok | ok | ok | ok | — |
| Monaco *(legacy)* | ok | ok | ok | **MISS** | **MISS** | ok |
| Courier New *(legacy)* | ok | ok | ok | **MISS** | **MISS** | ok |
| Andale Mono *(legacy)* | ok | ok | ok | **MISS** | **MISS** | ok |
| PT Mono *(legacy)* | ok | ok | ok | **MISS** | **MISS** | ok |

**`~`, `»`, `×` are in 100% of monospace fonts tested.** That is expected and structural: `~` is Basic Latin, `»` and `×` are Latin-1 Supplement and both are in [WGL4](https://learn.microsoft.com/en-us/typography/develop/wgl4) — the 653-codepoint repertoire Microsoft defined as the baseline every Windows font should cover. A monospace font missing them would be broken.

**`⊘` is missing from three of the four default/most-popular terminal fonts** — Cascadia Mono (Windows Terminal's default), SF Mono, and Fira Code. It survives only in Menlo, DejaVu Sans Mono, and JetBrains Mono. `⊘` is not in Latin-1 and not in WGL4 (WGL4's Mathematical Operators subset is only 17 codepoints — U+2202, 2206, 220F, 2211, 2212, 2215, 2219, 221A, 221E, 221F, 2229, 222B, 2248, 2260, 2261, 2264, 2265 — and U+2298 is not among them). It is also unlucky in its neighborhood in a second way: its immediate neighbors `⊕` U+2295 and `⊙` U+2299 *are* EAW=Ambiguous; U+2296..U+2298 are the Neutral carve-out.

**`✓` is safer than the Dingbats-block argument predicts.** Despite WGL4 omitting Dingbats entirely (zero U+27xx codepoints), U+2713 is covered by **every modern programming font tested** — Cascadia Mono, Cascadia Code, SF Mono, Fira Code, DejaVu Sans Mono, JetBrains Mono, Menlo. Its gaps are confined to *legacy* faces: Monaco, Courier New, Andale Mono, PT Mono. Those are rarely terminal defaults today, though Monaco was the classic macOS Terminal font and some long-lived profiles still carry it.

### Why `⊘` shipping "with no trouble" is weaker evidence than it looks

The viability baseline in #21 rests on `⊘` working today. The measurement says that works because **Terminal.app's and iTerm2's default font is Menlo, one of the few monospace faces carrying U+2298** — plus silent font fallback everywhere else. The existing no-trouble report is therefore consistent with "the author and users run macOS terminals on their default font", and is *not* evidence that `⊘` is broadly covered. On Windows Terminal's default Cascadia Mono it is already falling back today.

`…` U+2026 also already ships (`src/index.ts` — the "has a note" marker) and is universally covered, so it is a much better-supported precedent than `⊘`. Note however that `…` is itself **Ambiguous** (`2024..2027 ; A`), which means an ambiguous-width character already ships in this CLI's output without reported trouble — that *is* real evidence, and it applies directly to `×`.

### What fallback does to width

When the primary font lacks the glyph, the terminal substitutes another font. On this machine, the system fonts carrying U+2298 and their advance widths (em-relative):

| font with U+2298 | `⊘` advance | `M` advance | note |
|---|---|---|---|
| Menlo | 0.602 | 0.602 | monospace, exact cell |
| Apple Symbols | 0.722 | 0.560 | proportional — wider than the cell |
| Hiragino Sans | 0.868 | 0.925 | CJK font |
| Hiragino Kaku Gothic Pro | 0.870 | 0.945 | CJK font |
| STIXGeneral | 0.842 | 0.889 | proportional |
| Arial Unicode MS | 0.800 | 0.833 | proportional |
| `.LastResort` | 1.100 | 1.100 | **full-width** — the tofu-box font |

`fc-match ':charset=2298'` on this machine resolves to **Hiragino Sans** — a Japanese font. Same for `:charset=2713`. (`»`, `×`, `…` all resolve to Verdana.) A terminal is free to normalize a fallback glyph into one cell, and most do; but the fallback candidate for `⊘` being a CJK face is precisely the context UAX #11 §4.2 warns can promote a Neutral symbol to wide.

Per-platform fallback outcome for `⊘`, specifically:

- **macOS / Terminal.app / iTerm2 on Menlo** — native, exact cell. No fallback.
- **macOS on SF Mono** — CoreText falls back to a proportional face; Apple Symbols' advance is 0.722em against SF Mono's 0.618em, so the glyph is wider than the cell and may look heavy or clip. **Not tofu.**
- **Windows Terminal on Cascadia Mono** — DirectWrite system fallback (confirmed in `AtlasEngine.cpp`) picks a proportional face, likely Segoe UI Symbol or Cambria Math. **Not tofu**, but off-metric. The winning face was not verified.
- **VS Code** — xterm.js with the browser font stack; default terminal font is Menlo on macOS (fine), Consolas on Windows. **Consolas coverage of U+2298 is unverified.**

The consistent finding across all four: the realistic failure mode for `⊘` is **an off-metric fallback glyph, not a missing-glyph box.** Every target terminal does font fallback, and tofu (U+FFFD / `.LastResort`) is reserved for characters no installed font covers at all — which is not the case for any of these six.

**Within any font that has the glyph, width is a non-issue.** Measured advances confirm every glyph is exactly the monospace cell:

| font | `~` | `»` | `×` | `⊘` | `✓` | `…` | `A` (ref) |
|---|---|---|---|---|---|---|---|
| Menlo | 0.602 | 0.602 | 0.602 | 0.602 | 0.602 | 0.602 | 0.602 |
| Monaco | 0.600 | 0.600 | 0.600 | — | — | 0.600 | 0.600 |
| SF Mono | 0.618 | 0.618 | 0.618 | — | 0.618 | 0.618 | 0.618 |

So alignment breakage cannot come from the font-when-present. It can only come from (a) fallback into a proportional/CJK face, or (b) the terminal's own `wcwidth` deciding a character occupies two cells.

---

## 3. Terminal emulators — what each actually does

The question that matters: does any target terminal render one of these two cells wide?

### iTerm2 — setting exists, default off

Profiles → Text → "Double-Width Characters". [Documented](https://iterm2.com/documentation-preferences-profiles-text.html):

> There is another category of characters known as "ambiguous width". One example of ambiguous-width characters are Greek letters. Depending on your application, you may prefer to display them as double-width or single-width.

Default confirmed **from source**, not inferred: `sources/Settings/iTermProfilePreferences.m` defines `KEY_AMBIGUOUS_DOUBLE_WIDTH: @NO`, described as *"Whether to treat ambiguous-width characters as double-width"*. **Default: off.**

### macOS Terminal.app — setting exists, default off

Profiles → Advanced, per [Apple's documentation](https://support.apple.com/guide/terminal/trmladvn/mac):

> *Unicode East Asian Ambiguous characters are wide:* Treat the characters as East Asian Wide; otherwise, the characters are treated as East Asian Narrow.

Default-off is strongly supported (fzf#1533 and others describe it as something users *enable*) but Apple does not state the default explicitly — treat as strongly-supported, not primary-sourced.

### Windows Terminal — no setting, ambiguous forced narrow

Windows Terminal **deliberately has no ambiguous-width setting**. PR [microsoft/terminal#2928](https://github.com/microsoft/terminal/pull/2928) ("TermControl: force all ambiguous glyphs to be narrow", merged 2019-10-15) quotes Egmont Koblinger:

> glibc's `wcwidth()` reports 1 for ambiguous width characters, so the de facto standard is that in terminals they are narrow.

It closed #2066 and #2375; requests to make it configurable (#10844, #153) are closed as duplicates. **`×` is 1 cell unconditionally on Windows Terminal.**

Font fallback works: `src/renderer/atlas/AtlasEngine.cpp` calls `GetSystemFontFallback()` / `MapCharacters()` per run, with user mappings layered via `IDWriteFontFallbackBuilder`. A missing glyph lands on another installed font, **not tofu** (U+FFFD is reserved for true failure).

### VS Code / xterm.js — everything is width 1, no ambiguous branch at all

`src/common/input/UnicodeV6.ts` builds a 65536-entry table via `table.fill(1)` and then marks *wide* only: 0x1100–0x115F, 0x2329, 0x232A, 0x2E80–0xA4CF, 0xAC00–0xD7A3, 0xF900–0xFAFF, 0xFE10–0xFE19, 0xFE30–0xFE6F, 0xFF00–0xFF60, 0xFFE0–0xFFE6. **None of our five fall in those ranges, and there is no ambiguous-width branch whatsoever** — the corresponding feature request ([xtermjs/xterm.js#1453](https://github.com/xtermjs/xterm.js/issues/1453)) is still open.

The `addon-unicode11` `BMP_WIDE` table gives all five width 1 as well. VS Code's `terminal.integrated.unicodeVersion` defaults to `'11'` (verified in `terminalConfiguration.ts`, `default: '11'`), and **both** permitted values yield width 1 for all five — so the setting is a non-issue here.

### Net

| Terminal | Ambiguous → wide? | Default | `×` risk |
|---|---|---|---|
| macOS Terminal.app | opt-in setting | off | only if user opts in |
| iTerm2 | opt-in setting (`KEY_AMBIGUOUS_DOUBLE_WIDTH`) | off (source-verified) | only if user opts in |
| Windows Terminal | **impossible** — forced narrow by design | n/a | none |
| VS Code / xterm.js | **no such code path** | n/a | none |

**The only way any of these six glyphs renders two cells is a user deliberately enabling ambiguous-double-width in Terminal.app or iTerm2, and even then only `×` is affected.** Everything else is width 1 everywhere, in every configuration examined.

---

## 4. Locale and CI

### Node emits identical bytes regardless of locale — verified

`process.stdout.write()` of a JS string is UTF-8 encoded unconditionally; `LANG`/`LC_ALL` do not participate. Verified by hexdump:

```
$ node loc.js | xxd                      # LANG=en_US.UTF-8
glyphs: 7e 20 e28a98 20 e29c93 20 c2bb 20 c397 20 e280a6

$ LC_ALL=C LANG=C node loc.js | xxd      # LANG=C
glyphs: 7e 20 e28a98 20 e29c93 20 c2bb 20 c397 20 e280a6
```

Byte-identical. `e28a98`=U+2298, `e29c93`=U+2713, `c2bb`=U+00BB, `c397`=U+00D7, `e280a6`=U+2026.

**The locale question is therefore never a program-side question for this CLI.** It is entirely about what consumes the bytes.

### But libc `wcwidth` collapses under `LANG=C` — verified

Compiled against the system libc on macOS:

```
locale=en_US.UTF-8    ~ =1   » =1   × =1   ⊘ =1   ✓ =1   … =1
locale=C              ~ =1   » =-1  × =-1  ⊘ =-1  ✓ =-1  … =-1
locale=ja_JP.UTF-8    ~ =1   » =1   × =1   ⊘ =1   ✓ =1   … =1
```

Under `LANG=C`, `wcwidth()` returns **-1 (non-printable) for every non-ASCII character in the set** — `»` and `×` included, despite being Latin-1. Only `~` survives.

Two things follow:

1. This does not affect what the terminal *displays* — modern emulators decode UTF-8 regardless of `LANG`. It affects **downstream libc-based consumers**: `column`, `less`, ncurses-based pagers, anything computing display width via `wcswidth`. Piping glyph output into those under `LANG=C` is where alignment actually dies, and it dies for all five non-ASCII glyphs equally.
2. macOS libc does **not** widen Ambiguous characters under `ja_JP.UTF-8` — `×` measured 1, not 2. The ambiguous-wide behavior is a terminal-emulator setting, not a libc one, on this platform.

Node's own documentation (`doc/api/process.md`) confirms the general rule: JS strings are encoded to UTF-8 on write and the locale is never consulted for stdout. (The sync/async split it documents — files sync on both platforms, TTYs async on Windows and sync on POSIX, pipes the reverse — is orthogonal to encoding.)

### CI logs — partially unresolved

**GitHub Actions runner `LANG` values could not be confirmed from a primary source.** What was found: [discussion #149813](https://github.com/orgs/community/discussions/149813) shows `LANG=` empty with `LC_CTYPE=POSIX`, but that is a *self-hosted container image*, explicitly not the hosted runner, and it drew no official reply. `runner-images#762` has no maintainer statement. Secondary sources claim `C.UTF-8` on hosted `ubuntu-latest`; no primary confirmation. Nothing found for `windows-latest` or for the log viewer's encoding.

**This is likely moot regardless.** Per the verified result above, `LANG` does not affect the bytes a Node CLI emits — the CLI writes the same UTF-8 either way, and the Actions log viewer is a web UI consuming UTF-8. The cheap way to close this if it turns out to be load-bearing is one workflow job running `locale`.

Cargo's behavior is a useful cross-check here: it suppresses *progress rendering* under `is_ci()`, but that is about redraw/ANSI control, not about character repertoire.

---

## 5. Prior art — what shipped CLIs do

The dominant pattern is a **capability check at startup selecting between a Unicode glyph table and an ASCII fallback table**. The check is not a single convention: two of the most-used implementations disagree about what to even test.

### systemd — the cleanest example of the pattern

`src/basic/glyph-util.c` uses a two-row table selected by one predicate:

```c
return draw_table[force_utf || (code >= _GLYPH_FIRST_EMOJI ? emoji_enabled() : is_locale_utf8())][code];
```

Its fallback mapping is directly relevant to our set:

| Unicode | ASCII fallback |
|---|---|
| `✓` | `+` |
| `✗` | `-` |
| `●` | `*` |
| `○` | `*` |
| `├─` | `\|-` |
| `└─` | `` \`- `` |
| `…` | `...` |

Note systemd gates on **locale UTF-8-ness** (`is_locale_utf8()`), and gates emoji *more* strictly than plain glyphs — `emoji_enabled()` checks a `SYSTEMD_EMOJI` override, rejects `TERM` in `{dumb, linux}`, then falls through to `is_locale_utf8()`.

### The JS ecosystem: `is-unicode-supported` and `figures`

[`is-unicode-supported`](https://github.com/sindresorhus/is-unicode-supported) (the modern, sindresorhus-maintained answer, used widely) does **no locale sniffing at all**:

```js
if (process.platform !== 'win32') {
	return TERM !== 'linux'; // Linux console (kernel)
}
```

Everything non-Windows is assumed Unicode-capable unless it is the Linux kernel VT. Windows is an allowlist: `WT_SESSION` (Windows Terminal), `ConEmuTask === '{cmd::Cmder}'`, `TERM_PROGRAM === 'vscode'`, `TERM` in `xterm-256color`/`alacritty`/`rxvt-unicode`, `TERMINAL_EMULATOR === 'JetBrains-JediTerm'`. It deliberately does **not** consult `LANG`/`LC_ALL`.

[`has-unicode`](https://github.com/iarna/has-unicode) (npm's older dependency) does exactly the opposite — pure locale sniffing, and refuses Windows outright:

```js
if (os.type() == "Windows_NT") { return false }
var isUTF8 = /UTF-?8$/i
var ctype = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG
return isUTF8.test(ctype)
```

[`figures`](https://github.com/sindresorhus/figures) applies the gate once at module load and maps each figure. Relevant pairs:

| main | fallback |
|---|---|
| `✔` tick | `√` (U+221A) |
| `✘` cross | `×` (U+00D7) |
| `ℹ` info | `i` |
| `⚠` warning | `‼` (U+203C) |
| `❯` pointer | `>` |

**This is a significant data point for `×` specifically.** `figures` uses `×` U+00D7 as the *fallback* — the character it emits when it has concluded the terminal does **not** support Unicode. In other words, the most widely-installed glyph-fallback library in the JS ecosystem treats `×` as safe enough to be a **degradation target**, not a risk.

**And `figures`' "fallback" is not ASCII at all — it is roughly the CP437 / legacy DOS console repertoire:**

```js
const specialFallbackSymbols = {
	tick: '√',        info: 'i',       warning: '‼',     cross: '×',
	squareSmall: '□', squareSmallFilled: '■',
	circleCircle: '(○)',  circleCross: '(×)',  circlePipe: '(│)',
	radioOn: '(*)',   checkboxOn: '[×]',  pointer: '>',
	triangleUpOutline: '∆',  triangleLeft: '◄', triangleRight: '►',
	lozenge: '♦',     lozengeOutline: '◊',  hamburger: '≡',
	smiley: '☺',      mustache: '┌─┐',  star: '✶',  nodejs: '♦',
	oneSeventh: '1/7', oneNinth: '1/9', oneTenth: '1/10'
};
```

`√ ≡ ‼ ☺ ○ ◄ ► ♦` are all CP437 glyphs. (`× □ ◊ ∆ ✶` are not, so it is "approximately legacy DOS", not a strict code page.) The takeaway is that a widely-depended-on library does not consider "no Unicode support" to mean "ASCII only".

Also notable: `figures` puts arrows (`↑↓←→`), `●`, box-drawing, and **`…`** in its `common` set with **no fallback at all** — 109 entries emitted byte-identically in both modes.

### gh (GitHub CLI) — ships `✓` with no fallback whatsoever

`pkg/iostreams/color.go`:

```go
func (c *ColorScheme) SuccessIconWithColor(colo func(string) string) string { return colo("✓") }
func (c *ColorScheme) WarningIcon() string { return c.Yellow("!") }
func (c *ColorScheme) FailureIconWithColor(colo func(string) string) string { return colo("X") }
```

Success is **`✓` U+2713 — the exact codepoint proposed here** — while failure and warning are plain ASCII `X` and `!`. gh gates *color* on TTY but **never gates glyphs**, and has no Windows or non-UTF-8 fallback path. Given gh's deployment breadth (including Windows and CI), this is the strongest single precedent in the set for `✓`.

### cargo — gates exactly one character, and the polarity is instructive

`src/util/progress.rs`:

```rust
let (ellipsis, ellipsis_width) = if self.unicode { ("…", 1) } else { ("...", 3) };
```

The progress bar itself is ASCII (`[====>  ] 3/4`); `…` is the only character cargo bothers to gate. Progress is suppressed entirely under quiet, `TERM=dumb`, or `is_ci()`.

The capability check (`crates/cargo-util-terminal/src/shell.rs`):

```rust
fn supports_unicode(stream: &dyn IsTerminal) -> bool {
    !stream.is_terminal() || supports_unicode::supports_unicode()
}
```

**Note the polarity: a non-TTY short-circuits to `true`.** Piped, redirected, and CI output is *assumed Unicode-capable*; env sniffing runs only when the stream really is a terminal. This is the opposite of the intuition that piped output should be the conservative case.

### git — strictly ASCII, and actively escapes non-ASCII out

`git status --porcelain` output verified byte-wise via `od -c`: pure ASCII. Porcelain is an explicit stability contract. Beyond that, git *actively* escapes non-ASCII: `core.quotePath` defaults to true, so non-ASCII pathnames are C-quoted in output.

### The four postures

Across the tools examined, capability-gating falls into four distinct camps:

| Posture | Tools | Behavior |
|---|---|---|
| No check — just ship Unicode | **gh** | `✓` unconditionally |
| Check TTY/env, **default yes** | **cargo**, `is-unicode-supported` | non-TTY assumed capable |
| Check locale, **default no** | **systemd**, `has-unicode` | `is_locale_utf8()`; both are the older designs |
| Fall back to CP437, not ASCII | **figures** | `√ ≡ ‼ ☺ ×` |

**Nobody in the modern camps falls back to pure ASCII.** `✓` has the strongest precedent of our set (gh ships it ungated); `…` is the one character cargo gates; box-drawing is treated as safe by figures but gated conservatively by rustc diagnostics.

---

## 6. Summary matrix

| Glyph | EAW | Font coverage | Ambiguous-width risk | `LANG=C` libc width | Verdict on the evidence |
|---|---|---|---|---|---|
| `-` U+002D | Na | universal (ASCII) | none | 1 | zero risk |
| `~` U+007E | Na | universal (ASCII) | none | 1 | zero risk |
| `»` U+00BB | N | universal (Latin-1 + WGL4) | none — explicitly carved out of the ambiguous ranges | -1 | **no identified failure mode** |
| `×` U+00D7 | **A** | universal (Latin-1 + WGL4) | only if user opts into ambiguous-double-width in Terminal.app/iTerm2; impossible on Windows Terminal & xterm.js | -1 | low — one opt-in failure mode |
| `✓` U+2713 | N | all modern programming fonts; **missing from legacy** Monaco, Courier New, Andale, PT Mono | none observed | -1 | low — legacy fonts only |
| `⊘` U+2298 | N | **worst** — missing from Cascadia Mono, SF Mono, Fira Code | off-metric proportional/CJK fallback | -1 | **highest — the only measured problem** |

---

## 7. Gaps in this pass

Stated plainly rather than guessed at:

- **Terminal.app's default** for "East Asian Ambiguous characters are wide" is strongly supported as off (users describe *enabling* it) but Apple does not document the default. iTerm2's default-off **is** source-verified.
- **Consolas coverage of U+2298 is unverified** — this matters specifically for VS Code's integrated terminal on Windows, where Consolas is the default font. Consolas is widely reported to have limited Mathematical Operators coverage.
- **The specific Windows fallback face for `⊘`** (Segoe UI Symbol vs Cambria Math vs other) was not pinned down; only that DirectWrite fallback fires and it is not tofu.
- **GitHub Actions runner `LANG` values** and the Actions log viewer's Unicode handling remain unconfirmed from primary sources (§4). Probably moot — locale does not change the emitted bytes.
- **The Windows console code-page question** was not resolved: what a legacy console (CP437/CP1252, i.e. not Windows Terminal) does with UTF-8 bytes from Node, and whether Node sets the output code page. This is the one genuinely open technical question left.
- **eza, pytest, prettier, eslint** were not reached. gh, cargo, git, systemd, figures, is-unicode-supported and has-unicode are complete and verified.
- Font measurements come from **one macOS machine plus current upstream releases** of Cascadia/DejaVu/JetBrains/Fira. OS-shipped faces (Menlo, Monaco, Courier New, SF Mono) are stable; the rest reflect specific released versions.

## Method

Reproducible; scripts were throwaway. Unicode properties from the UCD files linked above. Font coverage and advance widths by reading `cmap`/`hmtx` tables with fontTools directly from font binaries. `wcwidth` behavior by compiling against the system libc and calling `setlocale()` per locale. Byte-level stdout behavior by hexdumping `node` output under differing `LANG`/`LC_ALL`.
