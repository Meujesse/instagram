// Prolonge le jeton Instagram (valable 60 jours) et le stocke chiffré dans le dépôt.
// Variables : IG_TOKEN_INIT (jeton collé par Jyn), TOKEN_KEY (clé de chiffrement). Sortie : IG_TOKEN dans GITHUB_ENV.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
const key = createHash('sha256').update(process.env.TOKEN_KEY || '').digest();
const enc = t => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const d = Buffer.concat([c.update(t, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), d]).toString('base64'); };
const dec = b => { const x = Buffer.from(b, 'base64'); const d = createDecipheriv('aes-256-gcm', key, x.subarray(0, 12)); d.setAuthTag(x.subarray(12, 28)); return Buffer.concat([d.update(x.subarray(28)), d.final()]).toString('utf8'); };
let etat = existsSync('jeton.json') ? JSON.parse(readFileSync('jeton.json', 'utf8')) : null;
let token = etat ? dec(etat.jeton) : process.env.IG_TOKEN_INIT;
if (!token) throw new Error('Aucun jeton : ajoutez le secret IG_TOKEN_INIT');
const age = etat ? (Date.now() - Date.parse(etat.prolonge_le)) / 864e5 : 99;
if (age > 7) {
  const r = await (await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`)).json();
  if (r.error) throw new Error('Prolongation du jeton : ' + r.error.message);
  token = r.access_token;
  etat = { jeton: enc(token), prolonge_le: new Date().toISOString(), expire_dans_jours: Math.round(r.expires_in / 864e2) };
  writeFileSync('jeton.json', JSON.stringify(etat, null, 1));
  console.log('Jeton prolongé.');
}
console.log(`::add-mask::${token}`);
appendFileSync(process.env.GITHUB_ENV, `IG_TOKEN=${token}\n`);
