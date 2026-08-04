# JetBrains Mono native font provenance

- Browser dependency: `@fontsource/jetbrains-mono@5.2.8`
- npm tarball: `https://registry.npmjs.org/@fontsource/jetbrains-mono/-/jetbrains-mono-5.2.8.tgz`
- npm integrity: `sha512-6w8/SG4kqvIMu7xd7wt6x3idn1Qux3p9N62s6G3rfldOUYHpWcc2FKrqf+Vo44jRvqWj2oAtTHrZXEP23oSKwQ==`
- Fontsource publish hash: `41d180552e2b34a3`
- Fontsource metadata: Google Fonts source, version `v24`, last modified `2025-09-11`
- Native assets: the unmodified `JetBrainsMono-Regular.ttf` and `JetBrainsMono-Bold.ttf` static fonts from the same Google Fonts import
- Google Fonts Regular source: `https://github.com/google/fonts/blob/2e05c1cf00a6e4f40a4b931600a90881c26e15cd/ofl/jetbrainsmono/static/JetBrainsMono-Regular.ttf`
- Google Fonts Bold source: `https://github.com/google/fonts/blob/2e05c1cf00a6e4f40a4b931600a90881c26e15cd/ofl/jetbrainsmono/static/JetBrainsMono-Bold.ttf`
- Google Fonts import: `2e05c1cf00a6e4f40a4b931600a90881c26e15cd` (`JetBrains Mono: Version 2.211 added`)
- Upstream source recorded by that import: `https://github.com/JetBrains/JetBrainsMono/commit/6a005ca77d9202aa12fc277aefa8f5bb4eb7f0cd`
- `JetBrainsMono-Regular.ttf` SHA-256: `08546b840f12407615e5bdf257bfdd2b42fc49a020ee51e4fd766ad2587f4bc5`
- `JetBrainsMono-Bold.ttf` SHA-256: `46fe456f11a4ebb5d8a621c033227dfd72a4783958e56f004057a7a3d884948e`
- `OFL.txt` SHA-256: `b2fe5e8987594e9ffd1d2ca52a2f5d73eb8335243893c5d6254b5ad69269591d`

The Fontsource 5.2.8 Latin 400 and 700 browser files and the corresponding vendored Google Fonts TTFs report the same PostScript names and internal font revision `144900` (JetBrains Mono 2.211). Verification used Fontsource's WOFF fallback files because the local Fontconfig build does not decode WOFF2:

- `jetbrains-mono-latin-400-normal.woff`: SHA-256 `658b9ee07b0249cf910a8d6f3d812d46c962bae81d7379a0355b1db35c61586f`, PostScript name `JetBrainsMono-Regular`, font revision `144900`
- `jetbrains-mono-latin-700-normal.woff`: SHA-256 `5e7319f25a5ef89d2c01c323029ef0bedefad204108e601455ff6f8ae12ca3ff`, PostScript name `JetBrainsMono-Bold`, font revision `144900`
- `jetbrains-mono-latin-400-normal.woff2`: SHA-256 `14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb`
- `jetbrains-mono-latin-700-normal.woff2`: SHA-256 `d0d4e818808f2a0ba39b2b09d1989366f63494e295f003c7ef436697378507e8`

The font is licensed under the SIL Open Font License 1.1. The authoritative Google Fonts license is included unchanged as `OFL.txt`.
