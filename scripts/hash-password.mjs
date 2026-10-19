#!/usr/bin/env node
// Prompts for a password (hidden input) and prints a scrypt hash for ADMIN_PASSWORD_HASH.
import { scryptSync, randomBytes } from 'node:crypto';

const N = 32768;

function prompt(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error('Run this in an interactive terminal.'));
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n');
          return resolve(buf);
        } else if (c === '\u0003') { stdout.write('\n'); process.exit(130); }
        else if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

const pw = await prompt('Contraseña: ');
if (pw.length < 10) { console.error('Usa al menos 10 caracteres.'); process.exit(1); }
const again = await prompt('Repite la contraseña: ');
if (pw !== again) { console.error('No coinciden.'); process.exit(1); }
const salt = randomBytes(16);
const hash = scryptSync(pw, salt, 64, { N, r: 8, p: 1, maxmem: 256 * N * 8 });
console.log(`scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`);
