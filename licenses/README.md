# Third-party notices

## Fonts embedded in PDF export

PDF export embeds the glyphs a document uses from these fonts, so text outside Windows-1252 (Greek, Cyrillic, extended Latin, symbols, emoji) prints instead of showing "?". All three are under the SIL Open Font License 1.1.

| Font | Version | Licence | Data module |
| --- | --- | --- | --- |
| Noto Sans Regular | 2.015 | [OFL-noto-sans.txt](OFL-noto-sans.txt) | `src/adapters/formats/pdf-fonts/noto-sans-regular.ts` |
| Noto Sans Bold | 2.015 | [OFL-noto-sans.txt](OFL-noto-sans.txt) | `src/adapters/formats/pdf-fonts/noto-sans-bold.ts` |
| Noto Emoji Regular (monochrome) | 3.006 | [OFL-noto-emoji.txt](OFL-noto-emoji.txt) | `src/adapters/formats/pdf-fonts/noto-emoji.ts` |

Source: the TTF files in the npm packages `@expo-google-fonts/noto-sans@0.4.2` and `@expo-google-fonts/noto-emoji@0.4.8` (copies of the Google Fonts releases).

The files were cut down with fontTools, keeping every character but dropping hinting and the OpenType layout tables, which PDF export does not use:

```
pyftsubset <font>.ttf --unicodes='*' --layout-features='' --no-hinting \
  --drop-tables+=GDEF,GPOS,GSUB,STAT,gasp,DSIG,MATH,COLR,CPAL,SVG,meta \
  --name-IDs='0,1,2,3,4,5,6,13,14' --glyph-names=false --notdef-outline --output-file=<out>.ttf
node tools/pdf-font-module.mjs <out>.ttf src/adapters/formats/pdf-fonts/<name>.ts <EXPORT_NAME>
```

The data modules hold the cut-down TTF compressed with raw deflate and written as base64.
