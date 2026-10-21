"use strict";

function fileKindFromName(name) {
  var m = /\.([a-z0-9]+)$/i.exec(name || "");
  var ext = m ? m[1].toLowerCase() : "";
  if (ext === "docx") return "docx";
  if (ext === "csv") return "csv";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "txt") return "txt";
  if (ext === "splitpage") return "splitpage";
  if (ext === "html" || ext === "htm") return "html";
  return null;
}

function mimeForFilename(filename) {
  var ext = (/\.([a-z0-9]+)$/i.exec(filename || "") || ["", ""])[1].toLowerCase();
  if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === "csv") return "text/csv";
  if (ext === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "pdf") return "application/pdf";
  if (ext === "html") return "text/html";
  if (ext === "splitpage") return "application/json";
  if (ext === "zip") return "application/zip";
  return "text/plain";
}

module.exports = {
  fileKindFromName,
  mimeForFilename
};
