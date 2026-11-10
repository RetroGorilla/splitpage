# PROJ round-trip B

Shows projection loss relative to a direct app save; replay with node src/proj/report.ts --write.

merge-text-unicode-and-atoms.json/inputs/base

```json
[
  {
    "path": "$.rows.3.visualText",
    "before": "a&nbsp;b c​d",
    "after": "a&nbsp;b cd"
  }
]
```

merge-text-unicode-and-atoms.json/inputs/mine

```json
[
  {
    "path": "$.rows.3.visualText",
    "before": "a&nbsp;b c​d e",
    "after": "a&nbsp;b cd e"
  }
]
```

merge-text-unicode-and-atoms.json/inputs/theirs

```json
[
  {
    "path": "$.rows.3.visualText",
    "before": "A&nbsp;b c​d",
    "after": "A&nbsp;b cd"
  }
]
```

migrate-golden.json/scenarios/media in cells/output

```json
[
  {
    "path": "$.rows.1.audioText",
    "before": "<span class=\"cmt-anchor\" data-cmt=\"mintedc1\">anchor without id</span> and <span class=\"broll-key\" data-broll-id=\"mintedbs1\" contenteditable=\"false\">B-roll:</span> city <span class=\"tag-anchor\" data-tag-cat=\"prop\" data-tag-name=\"gaffer tape\" contenteditable=\"false\">gaffer tape</span> <span class=\"audio-cue\">SFX: <span class=\"tag-anchor\" data-tag-cat=\"sound\" data-tag-name=\"Thunder\" contenteditable=\"false\">Thunder</span></span>",
    "after": "<span class=\"cmt-anchor\" data-cmt=\"mintedc1\">anchor without id</span> and <span class=\"broll-key\" data-broll-id=\"mintedbs1\" contenteditable=\"false\">B-roll:</span> city <span class=\"tag-anchor\" data-tag-cat=\"prop\" data-tag-name=\"gaffer tape\" contenteditable=\"false\">gaffer tape</span> SFX: <span class=\"tag-anchor\" data-tag-cat=\"sound\" data-tag-name=\"Thunder\" contenteditable=\"false\">Thunder</span>"
  }
]
```

supplement.splitpage

```json
[
  {
    "path": "$.rows.0.imageLinks.0.location",
    "before": {
      "kind": "path",
      "path": "C:\\shoot\\take.mp4"
    }
  },
  {
    "path": "$.rows.0.imageLinks.1.location",
    "before": {
      "kind": "bundled",
      "name": "notes.pdf"
    }
  }
]
```
