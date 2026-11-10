A selection does not survive DOM replacement automatically; retained offsets restore it on unchanged content.

Observed in Edg/157.0.4341.42. Reproduce with `npm run slice` under the smoke lock.

whole repaint selection

```text
stage 0: text="the the" selection=[4,4]
stage 1: text="the the" selection=[0,0]
```

text repaint selection

```text
stage 0: text="the the" selection=[4,4]
stage 1: text="the the" selection=[3,3]
```

whole repaint explicit selection restoration

```text
stage 0: text="the the" selection=[4,7]
stage 1: text="the the" selection=[4,7]
```
