// Publie chaque jour le prochain post du calendrier sur Instagram (API officielle, connexion Instagram).
// Variables : IG_TOKEN (jeton longue durée). Aucun module externe.
import { readFileSync, writeFileSync } from 'node:fs';

const API = 'https://graph.instagram.com/v23.0';
const TOKEN = process.env.IG_TOKEN;
const DRY = process.argv.includes('--essai');
if (!TOKEN && !DRY) throw new Error('IG_TOKEN manquant');

const cal = JSON.parse(readFileSync('calendrier.json', 'utf8'));
const heureParis = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
if (!process.env.FORCER && heureParis < '12:25') { console.log(`Trop tôt (${heureParis} à Paris), publication à partir de 12 h 25.`); process.exit(0); }
const today = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(new Date());
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Instagram renvoie parfois une réponse vide ou une erreur passagère : on réessaie (3 fois, 30 s d'écart).
// Sauf pour media_publish, où un nouvel essai risquerait de publier deux fois.
async function call(path, params = {}, method = 'POST') {
  const url = new URL(API + path);
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const essais = path.endsWith('/media_publish') ? 1 : 3;
  for (let i = 1; ; i++) {
    const res = method === 'GET'
      ? await fetch(url + '?' + body)
      : await fetch(url, { method, body });
    const brut = await res.text();
    let j; try { j = JSON.parse(brut); } catch { j = { error: { message: `réponse illisible (${res.status}) ${brut.slice(0, 200)}`, transitoire: true } }; }
    if (!j.error) return j;
    const passager = j.error.transitoire || j.error.is_transient || res.status >= 500;
    if (!passager || i >= essais) throw new Error(`${path} : ${j.error.message}`);
    console.log(`${path} : ${j.error.message}, nouvel essai dans 30 s`);
    await sleep(30000);
  }
}

async function waitReady(id) {
  for (let i = 0; i < 60; i++) {
    const s = await call(`/${id}`, { fields: 'status_code,status' }, 'GET');
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Conteneur ${id} : ${s.status}`);
    await sleep(10000);
  }
  throw new Error(`Conteneur ${id} pas prêt après 10 min`);
}

const parisDay = iso => new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(new Date(iso));
const dejaFait = cal.find(p => p.publie && parisDay(p.publie.le) === today);
if (dejaFait) { console.log(`Déjà publié aujourd'hui (${dejaFait.id}), rien de plus.`); process.exit(0); }
const post = cal.find(p => !p.publie && !p.attente && p.date && p.date <= today);
if (!post) {
  if (!DRY) { const m = await call('/me', { fields: 'username' }, 'GET'); console.log(`Accès Instagram OK (@${m.username}).`); }
  console.log(`Rien à publier le ${today}.`); process.exit(0);
}
console.log(`Post ${post.id} prévu le ${post.date} (${post.format})`);
if (DRY) { console.log(JSON.stringify(post, null, 1).slice(0, 1500)); process.exit(0); }

const me = await call('/me', { fields: 'user_id,username' }, 'GET');
const ig = me.user_id;
let creation;
if (post.format === 'reel') {
  const p = { media_type: 'REELS', video_url: post.video_url, caption: post.caption, share_to_feed: 'true' };
  if (post.cover_url) p.cover_url = post.cover_url;
  creation = (await call(`/${ig}/media`, p)).id;
} else if (post.format === 'carrousel') {
  const kids = [];
  for (const u of post.images) {
    const k = (await call(`/${ig}/media`, { image_url: u, is_carousel_item: 'true' })).id;
    await waitReady(k); kids.push(k);
  }
  creation = (await call(`/${ig}/media`, { media_type: 'CAROUSEL', children: kids.join(','), caption: post.caption })).id;
} else {
  creation = (await call(`/${ig}/media`, { image_url: post.images[0], caption: post.caption })).id;
}
await waitReady(creation);
const pub = await call(`/${ig}/media_publish`, { creation_id: creation });
const info = await call(`/${pub.id}`, { fields: 'permalink' }, 'GET');
post.publie = { le: new Date().toISOString(), media_id: pub.id, lien: info.permalink };
writeFileSync('calendrier.json', JSON.stringify(cal, null, 1));
console.log(`Publié : ${info.permalink}`);
