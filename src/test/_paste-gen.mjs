export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

export function pngDataUrl(width, height, salt) {
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52,
    ...be32(width), ...be32(height), 8, 6, 0, 0, 0, ...be32(salt), 0x49, 0x45, 0x4e, 0x44];
  return "data:image/png;base64," + Buffer.from(bytes).toString("base64");
}

export const KEY_IDS = ["bsA", "bsB", "bsZ", "bsY"];

const key = (id) => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">B-roll:</span>`;
const tag = (name) => `<span class="tag-anchor" data-tag-cat="prop" data-tag-name="${name}" contenteditable="false">${name}</span>`;
const pic = (n) => `<img src="${pngDataUrl(3 + n, 2 + n, n)}">`;

export const OPENERS = [
  ["<b>", "</b>"],
  ["<strong>", "</strong>"],
  ["<em>", "</em>"],
  ["<i>", "</i>"],
  ["<u>", "</u>"],
  ["<s>", "</s>"],
  ["<mark>", "</mark>"],
  ["<font>", "</font>"],
  ["<p>", "</p>"],
  ["<div>", "</div>"],
  ["<span>", "</span>"],
  ["<table><td>", "</td></table>"],
  ["<object>", "</object>"],
  ['<span style="font-weight:700">', "</span>"],
  ['<span style="font-style:italic;font-weight:400">', "</span>"],
  ['<span style="text-decoration:underline;background-color:yellow">', "</span>"],
  ['<b style="font-weight:normal;" id="docs-internal-guid-x">', "</b>"],
  ['<span class="stage-dir">', "</span>"],
  ['<span class="audio-cue">', "</span>"],
  ['<span class="cmt-anchor" data-cmt="c1">', "</span>"],
  ['<span class="cmt-anchor" data-cmt="c2">', "</span>"],
  ['<span data-splitpage-cut="feedface">', "</span>"],
  ['<a href="https://one.test/">', "</a>"],
  ['<a href="https://youtu.be/abc">', "</a>"],
  ['<a href="https://vimeo.com/76979871">', "</a>"],
  ['<a href="javascript:alert(1)">', "</a>"],
  ['<a class="video-embed-card" href="https://www.loom.com/share/abc">', "</a>"],
  ['<i onclick="x()" onmouseover="y()">', "</i>"],
  ["<style>", "</style>"],
  ["<script>", "</script>"],
  ["<template>", "</template>"],
  ["<noscript>", "</noscript>"],
  ["<picture>", "</picture>"],
  ["<video src=\"https://cdn.example.com/a.webm\">", "</video>"]
];

const ZERO_WIDTH = String.fromCharCode(0x200b);
const COMBINED = "e" + String.fromCharCode(0x301);
const SMILE = String.fromCharCode(0xd83d, 0xde00);
const LONE_HALF = String.fromCharCode(0xd83d);

const LEAVES = [
  "x", "y z", " ", "<br>", "", "hello world", "Tom &amp; Jerry", "1 &lt; 2", "nb&nbsp;sp", "line\none",
  ZERO_WIDTH, COMBINED, SMILE, LONE_HALF, "B-roll: drone", "shot ",
  key("bsA"), key("bsB"), key("bsZ"), key("bsY"), key(""), tag("mug"), tag("lamp"),
  pic(1), pic(2), '<img src="https://example.com/p.png">', '<img data-blob="' + "a".repeat(64) + '">',
  '<a class="video-embed-card" href="https://vimeo.com/1">Watch video</a>',
  "<!--StartFragment-->", "<!--EndFragment-->", '<meta charset="utf-8">', '<link rel="stylesheet" href="x.css">',
  "https://youtu.be/abc123", "see https://example.com/page"
];

function genHtml(rnd, depth) {
  let out = "";
  const n = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    if (depth <= 0 || rnd() < 0.35) {
      out += LEAVES[Math.floor(rnd() * LEAVES.length)];
    } else {
      const [open, close] = OPENERS[Math.floor(rnd() * OPENERS.length)];
      out += open + genHtml(rnd, depth - 1) + close;
    }
  }
  return out;
}

export function genPaste(rnd) {
  const kind = rnd();
  if (kind < 0.12) return { html: "", text: LEAVES[Math.floor(rnd() * LEAVES.length)].replace(/<[^>]*>/g, "") + (rnd() < 0.5 ? "\r\nmore" : "") };
  const html = genHtml(rnd, 1 + Math.floor(rnd() * 4));
  return { html: html, text: html.replace(/<[^>]*>/g, "") };
}
