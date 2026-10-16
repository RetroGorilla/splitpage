"use strict";

const LOOPBACK_HOST = "127.0.0.1";
const ALL_INTERFACES_HOST = "0.0.0.0";

function documentServerHost(options) {
  const opts = options || {};
  if (opts.testMode === true) return LOOPBACK_HOST;
  return opts.hosting === true ? ALL_INTERFACES_HOST : LOOPBACK_HOST;
}

module.exports = { documentServerHost, LOOPBACK_HOST, ALL_INTERFACES_HOST };
