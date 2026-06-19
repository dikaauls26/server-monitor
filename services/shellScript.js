'use strict';

/** Collapse a multi-line shell script into one line for SSH exec. */
function shellOneLine(script) {
  return script
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('; ');
}

module.exports = { shellOneLine };
