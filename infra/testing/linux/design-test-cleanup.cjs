"use strict";
function fixtureKeyRemovalScript(publicKey) {
  const key = String(publicKey).trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+ /.test(key) || key.includes(String.fromCharCode(10)) || key.includes(String.fromCharCode(13))) throw Error("INVALID_FIXTURE_PUBLIC_KEY");
  // Avoid nested newline escapes: this source is transported as a second JavaScript program.
  return `const fs=require('node:fs');const p='/root/.ssh/authorized_keys';const key=${JSON.stringify(key)};const newline=String.fromCharCode(10);fs.writeFileSync(p,fs.readFileSync(p,'utf8').split(newline).filter(line=>line.trim()!==key).join(newline),{mode:0o600});`;
}
module.exports = { fixtureKeyRemovalScript };
