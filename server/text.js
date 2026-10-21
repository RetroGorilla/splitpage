"use strict";

function codePointPrefix(text, max) {
  let end = 0;
  for (let n = 0; n < max && end < text.length; n++) {
    end += text.codePointAt(end) > 0xffff ? 2 : 1;
  }
  return text.slice(0, end);
}

module.exports = { codePointPrefix };
