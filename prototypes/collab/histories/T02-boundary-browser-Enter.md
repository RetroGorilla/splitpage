Native Enter changes paragraph/beat DOM structure; a single-beat text splice cannot implement the app's structural command.

Observed in Edg/157.0.4341.42. Start with <strong>the</strong> the and a caret at offset 4.

```text
beforeinput(insertParagraph) text="the the" ranges=[[4,4]]
input(insertParagraph) text="the" ranges=[]
```

Resulting root DOM:

```html
<div class="wr-par"><span class="wr-beat" data-id="R1" data-field="audioText"><strong>the</strong> </span></div><div class="wr-par"><span class="wr-beat" data-id="R1" data-field="audioText">the</span></div>
```

The app already cancels insertParagraph and runs enterAt; this slice observes the native default only.
