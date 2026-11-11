export const samePayloadMarkCases = [
  { kind: "tag", base: 'a<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">bc</span>d',
    html: '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">a<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">bc</span>d</span>',
    mark: { kind: "tag", id: "t:prop:Box", value: "t:prop:Box" }, standaloneCounts: [1, 2, 2, 1] },
  { kind: "link", base: 'a<a href="https://x" target="_blank" rel="noopener">bc</a>d',
    html: '<a href="https://x" target="_blank" rel="noopener">abcd</a>',
    mark: { kind: "link", id: "https://x", value: "https://x" }, standaloneCounts: [1, 1, 1, 1] },
  { kind: "comment", base: 'a<span class="cmt-anchor" data-cmt="C">bc</span>d',
    html: '<span class="cmt-anchor" data-cmt="C">abcd</span>',
    mark: { kind: "comment", id: "C", value: true }, standaloneCounts: [1, 1, 1, 1] }
] as const;

export const sharedTagNameLimit = "standalone can stack one tag name twice on the same characters; shared identified names are present or absent per character";
export const sharedTagNameCases = [
  { field: "audioText", base: 'a<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">bc</span>d',
    standaloneAdded: '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">a<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">bc</span>d</span>',
    sharedAdded: '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">abcd</span>',
    standaloneCleared: 'a<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">bc</span>d', sharedCleared: "abcd" },
  { field: "visualText", base: 'a<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">bc</span>d',
    standaloneAdded: '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">a<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">bc</span>d</span>',
    sharedAdded: '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">abcd</span>',
    standaloneCleared: 'a<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">bc</span>d', sharedCleared: "abcd" }
] as const;

export const samePayloadTextFields = [
  { field: "audioText", all: ['["flow-base","R1","audioText",0,1]', '["flow-base","R1","audioText",1,2]', '["flow-base","R1","audioText",2,3]', '["flow-base","R1","audioText",3,4]'],
    edges: ['["flow-base","R1","audioText",0,1]', '["flow-base","R1","audioText",3,4]'] },
  { field: "visualText", all: ['["flow-base","R1","visualText",0,1]', '["flow-base","R1","visualText",1,2]', '["flow-base","R1","visualText",2,3]', '["flow-base","R1","visualText",3,4]'],
    edges: ['["flow-base","R1","visualText",0,1]', '["flow-base","R1","visualText",3,4]'] }
] as const;
