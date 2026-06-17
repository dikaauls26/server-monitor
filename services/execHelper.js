'use strict';

/**
 * Promisified command execution with a hard timeout.
 * Never throws on non-zero exit; resolves with { ok, stdout, stderr, code }.
 * This keeps probes safe even on systems where a tool is missing.
 */

const { exec } = require('child_process');

function run(command, { timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    exec(command, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 * 4 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
        error: err ? err.message : null,
      });
    });
  });
}

/**
 * Returns true if a command exists on PATH (Linux/macOS).
 */
async function commandExists(bin) {
  const res = await run(`command -v ${bin}`, { timeout: 3000 });
  return res.ok && res.stdout.trim().length > 0;
}

module.exports = { run, commandExists };
