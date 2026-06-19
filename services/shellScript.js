'use strict';

/**
 * Wrap a multi-line bash script for execution over SSH.
 * Base64 keeps if/else blocks valid (semicolon-join breaks `then;` / `else;`).
 */
function remoteBash(script) {
  const body = script.trim() + '\n';
  const encoded = Buffer.from(body, 'utf8').toString('base64');
  return `echo '${encoded}' | base64 -d | bash`;
}

module.exports = { remoteBash };
