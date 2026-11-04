// Publie chaque jour le prochain post du calendrier sur Instagram (API officielle, connexion Instagram).
// Variables : IG_TOKEN (jeton longue durée). Aucun module externe.
// Modes :
//   (aucun)        publie le post du jour ; en cas de panne, ne prévient personne et laisse le passage suivant réessayer
//   --soir         dernier passage de la journée : rattrape le post du jour s'il n'est pas parti, répète celui de demain,
//                  et prévient Jyn (une seule fois par jour) si l'un des deux a un souci
//   --repetition   prépare le prochain post en entier chez Instagram (conteneur jamais publié, effacé au bout de 24 h)
//   --essai        n'appelle rien, --test-alerte vérifie que l'alerte arrive bien
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const API = 'https://graph.instagram.com/v23.0';
const TOKEN = process.env.IG_TOKEN;
const mode = ['essai', 'repetition', 'soir', 'test-alerte'].find(m => process.argv.includes('--' + m)) || 'publier';
if (!TOKEN && mode !== 'essai') throw new Error('IG_TOKEN manquant');

const cal = JSON.parse(readFileSync('calendrier.json', 'utf8'));
const etat = existsSync('etat.json') ? JSON.parse(readFileSync('etat.json', 'utf8')) : {};
const paris = (o, d = new Date()) => new Intl.DateTimeFormat(o === 'jour' ? 'fr-CA' : 'fr-FR',
  o === 'jour' ? { timeZone: 'Europe/Paris' } : { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const today = paris('jour');
// Réglages propres à chaque compte (fixés dans le workflow) : nom dans les alertes, heure de publication, jours prévus seulement.
const NOM = process.env.NOM_ROBOT || 'robot Instagram';
const HEURE_MIN = process.env.HEURE_MIN || '12:25';
const JOURS_PREVUS = !!process.env.SEULEMENT_JOURS_PREVUS;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sauver = () => { writeFileSync('calendrier.json', JSON.stringify(cal, null, 1)); writeFileSync('etat.json', JSON.stringify(etat, null, 1)); };
// Une alerte devient un ticket GitHub (étape « Prévenir Jyn ») : Jyn reçoit un seul mail, en français.
const alerte = msg => { etat.alerte = etat.alerte ? `${etat.alerte} ${msg}` : msg; console.log(`::error title=${NOM}::${msg}`); };
const fin = code => { sauver(); process.exit(code); };

// Instagram renvoie parfois une réponse vide ou une erreur passagère : on réessaie (3 fois, 30 s d'écart).
// Sauf pour media_publish, où un nouvel essai risquerait de publier deux fois.
async function call(path, params = {}, method = 'POST') {
  const url = new URL(API + path);
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const essais = path.endsWith('/media_publish') ? 1 : 3;
  for (let i = 1; ; i++) {
    let res, brut;
    try {
      res = method === 'GET' ? await fetch(url + '?' + body) : await fetch(url, { method, body });
      brut = await res.text();
    } catch (e) { res = { status: 0 }; brut = `réseau : ${e.message}`; }
    let j; try { j = JSON.parse(brut); } catch { j = { error: { message: `réponse illisible (${res.status}) ${brut.slice(0, 200)}`, transitoire: true } }; }
    if (!j.error) return j;
    if (j.error.code === 190) { const e = new Error('jeton refusé'); e.jeton = true; throw e; }
    const passager = j.error.transitoire || j.error.is_transient || res.status >= 500 || j.error.code === 2;
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

// Contrôles sans appel à Instagram : ce qui ferait échouer la publication à coup sûr.
async function controler(post) {
  const pb = [];
  const cap = post.caption || '';
  if (cap.length > 2200) pb.push(`légende trop longue (${cap.length} caractères, 2 200 au plus)`);
  if ((cap.match(/#[\p{L}\p{N}_]+/gu) || []).length > 30) pb.push('plus de 30 hashtags');
  if (!['image', 'reel', 'carrousel'].includes(post.format)) pb.push(`format inconnu (${post.format})`);
  if (post.format === 'carrousel' && !(post.images?.length >= 2 && post.images.length <= 10)) pb.push(`carrousel de ${post.images?.length || 0} images (2 à 10)`);
  if (post.format === 'image' && !post.images?.[0]) pb.push('image manquante');
  if (post.format === 'reel' && !post.video_url) pb.push('vidéo manquante');
  // Les médias doivent être en ligne, en JPEG pour les images (exigence d'Instagram).
  const urls = post.format === 'reel' ? [post.video_url, post.cover_url].filter(Boolean) : post.images || [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { method: 'HEAD' });
      const type = r.headers.get('content-type') || '';
      if (!r.ok) pb.push(`média introuvable (${r.status}) : ${u}`);
      else if (/\.(jpe?g)$/i.test(u) && !/jpeg/.test(type)) pb.push(`image pas en JPEG : ${u}`);
    } catch (e) { pb.push(`média injoignable : ${u}`); }
  }
  return pb;
}

// Crée le conteneur Instagram du post (sans le publier) et attend qu'il soit prêt.
async function preparer(post, ig) {
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
  return creation;
}

let compte;
const ig = async () => (compte ||= (await call('/me', { fields: 'user_id,username' }, 'GET')).user_id);

async function repeter(post) {
  const pb = await controler(post);
  if (pb.length) throw new Error(pb.join(', '));
  await preparer(post, await ig());
  console.log(`Répétition ${post.id} (${post.format}) réussie : médias acceptés par Instagram, post prêt.`);
}

async function publier(post) {
  const pb = await controler(post);
  if (pb.length) throw new Error(pb.join(', '));
  const id = await ig();
  const creation = await preparer(post, id);
  const pub = await call(`/${id}/media_publish`, { creation_id: creation });
  post.publie = { le: new Date().toISOString(), media_id: pub.id, lien: null };
  sauver();
  post.publie.lien = (await call(`/${pub.id}`, { fields: 'permalink' }, 'GET').catch(() => ({}))).permalink || null;
  sauver();
  console.log(`Publié : ${post.publie.lien || pub.id}`);
}

const dejaFait = cal.find(p => p.publie && paris('jour', new Date(p.publie.le)) === today);
const aPublier = p => !p.publie && !p.attente && p.date;
const duJour = () => cal.find(p => aPublier(p) && p.date <= today);
const prochain = () => cal.find(p => aPublier(p) && p.date > today);
const jetonRefuse = e => { if (e.jeton) { alerte(`Le jeton Instagram est expiré ou refusé : il faut en générer un nouveau. Dis à Claude « Regarde l'alerte du ${NOM} ».`); fin(0); } };

if (mode === 'test-alerte') { alerte(`Test du système d'alerte du ${NOM} : tout va bien, ce message peut être ignoré.`); fin(0); }

if (mode === 'repetition') {
  const p = duJour() || prochain();
  if (!p) { console.log('Aucun post à venir.'); fin(0); }
  try { await repeter(p); fin(0); } catch (e) { jetonRefuse(e); alerte(`La répétition du post Instagram ${p.id} (prévu le ${p.date}) a échoué : ${e.message.slice(0, 300)}.`); fin(0); }
}

if (mode === 'soir') {
  if (etat.soir === today) { console.log('Contrôle du soir déjà fait aujourd\'hui.'); fin(0); }
  etat.soir = today;
  const p = duJour();
  const prevu = !JOURS_PREVUS || cal.some(x => x.date === today);
  if (p && !dejaFait && prevu) {
    console.log(`Rattrapage du post ${p.id}, pas encore parti aujourd'hui.`);
    try { await publier(p); } catch (e) { jetonRefuse(e); alerte(`Le post Instagram ${p.id} (« ${(p.titre || '').slice(0, 60)} ») n'est pas parti aujourd'hui malgré plusieurs essais : ${e.message.slice(0, 300)}. Le robot le retentera demain ; dis à Claude « Regarde l'alerte du ${NOM} ».`); }
  } else console.log(dejaFait ? 'Post du jour bien parti.' : 'Rien de prévu aujourd\'hui.');
  const n = prochain();
  if (n) {
    try { await repeter(n); } catch (e) { jetonRefuse(e); alerte(`Le prochain post Instagram ${n.id} (prévu le ${n.date}) ne passera pas en l'état : ${e.message.slice(0, 300)}. Dis à Claude « Regarde l'alerte du ${NOM} ».`); }
  }
  const reste = cal.filter(aPublier).length;
  if (reste <= 15) alerte(`Plus que ${reste} posts Instagram en stock : il faut en ajouter.`);
  fin(0);
}

// Passage normal de la journée.
const heure = paris('heure');
if (!process.env.FORCER && heure < HEURE_MIN) { console.log(`Trop tôt (${heure} à Paris), publication à partir de ${HEURE_MIN}.`); fin(0); }
if (dejaFait) { console.log(`Déjà publié aujourd'hui (${dejaFait.id}), rien de plus.`); fin(0); }
if (JOURS_PREVUS && !cal.some(x => x.date === today)) { console.log(`Pas de post prévu le ${today}.`); fin(0); }
const post = duJour();
if (!post) { console.log(`Rien à publier le ${today}.`); fin(0); }
console.log(`Post ${post.id} prévu le ${post.date} (${post.format})`);
if (mode === 'essai') { console.log(JSON.stringify(post, null, 1).slice(0, 1500)); process.exit(0); }
try { await publier(post); fin(0); } catch (e) {
  jetonRefuse(e);
  // Pas d'alerte ici : un autre passage réessaiera, et le contrôle du soir préviendra Jyn si rien n'est parti.
  console.log(`::warning title=Essai sans succès::${e.message.slice(0, 400)} (nouvel essai au prochain passage)`);
  fin(0);
}
