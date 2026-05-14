const express = require('express');
const app = express();

app.use(express.json());

// ─── Vérification de l'environnement au démarrage ───────────────────────────
const REQUIRED_ENV = [
  'IMMOFACILE_SITE_ID',
  'IMMOFACILE_LOGIN',
  'IMMOFACILE_PASSWORD',
  'WEBHOOK_SECRET'
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Variable d'environnement manquante : ${key}`);
    process.exit(1);
  }
}

const IMMOFACILE_BASE_URL = 'https://v2.immo-facile.com/api';

// ─── Utilitaire de log ───────────────────────────────────────────────────────
function log(level, message, data = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data
  }));
}

// ─── Récupération du token ImmoFacile (Basic Auth) ──────────────────────────
async function getImmoFacileToken() {
  const credentials = Buffer.from(
    `${process.env.IMMOFACILE_LOGIN}:${process.env.IMMOFACILE_PASSWORD}`
  ).toString('base64');

  const response = await fetch(
    `${IMMOFACILE_BASE_URL}/client/token/site?site_id=${process.env.IMMOFACILE_SITE_ID}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Impossible d'obtenir le token ImmoFacile : ${response.status} ${body}`);
  }

  const data = await response.json();
  // Le token est généralement dans data.token ou data.access_token
  const token = data.token || data.access_token || data;
  log('info', 'Token ImmoFacile obtenu avec succès');
  return token;
}

// ─── Transformation Brevo → ImmoFacile ──────────────────────────────────────
function transformContact(brevoPayload) {
  const attr = brevoPayload.attributes || {};

  // Toutes les infos projet + notes regroupées dans le champ "comment"
  const commentParts = [];
  if (attr.SOURCE)      commentParts.push(`Source : ${attr.SOURCE}`);
  if (attr.TYPE_PROJET) commentParts.push(`Projet : ${attr.TYPE_PROJET}`);
  if (attr.BUDGET)      commentParts.push(`Budget : ${attr.BUDGET}`);
  if (attr.VILLE)       commentParts.push(`Ville : ${attr.VILLE}`);
  if (attr.NOTES)       commentParts.push(`Notes : ${attr.NOTES}`);
  commentParts.push(`Reçu le : ${new Date().toLocaleString('fr-FR')}`);

  return {
    firstname : attr.PRENOM        || null,
    lastname  : attr.NOM           || null,
    email     : brevoPayload.email || null,
    phone     : attr.TELEPHONE     || null,
    comment   : commentParts.join(' | '),
  };
}

// ─── Envoi vers ImmoFacile avec retry ───────────────────────────────────────
async function sendToImmoFacile(lead, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 2000;

  try {
    // 1. Obtenir un token frais à chaque envoi
    const token = await getImmoFacileToken();

    // 2. Créer le contact
    const response = await fetch(
      `${IMMOFACILE_BASE_URL}/site/customer?site_id=${process.env.IMMOFACILE_SITE_ID}`,
      {
        method: 'POST',
        headers: {
          'Content-Type' : 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(lead),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`ImmoFacile a répondu ${response.status} : ${body}`);
    }

    const result = await response.json().catch(() => ({}));
    log('info', 'Lead transmis avec succès à ImmoFacile', {
      email  : lead.email,
      attempt,
      immoId : result.id || null,
    });
    return result;

  } catch (err) {
    log('warn', `Tentative ${attempt}/${MAX_ATTEMPTS} échouée`, {
      email : lead.email,
      error : err.message,
    });

    if (attempt < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      return sendToImmoFacile(lead, attempt + 1);
    }

    throw err;
  }
}

// ─── Route de santé ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'brevo-immofacile-middleware' });
});

// ─── Webhook principal ───────────────────────────────────────────────────────
app.post('/webhook/brevo', async (req, res) => {

  // 1. Vérification du secret partagé
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    log('warn', 'Tentative sans secret valide', { ip: req.ip });
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const payload = req.body;

  // 2. Validation minimale
  if (!payload || !payload.email) {
    log('warn', 'Payload invalide reçu (email manquant)', { payload });
    return res.status(400).json({ error: 'Email manquant dans le payload' });
  }

  log('info', 'Webhook Brevo reçu', {
    email  : payload.email,
    source : payload.attributes?.SOURCE
  });

  // 3. Réponse immédiate à Brevo, traitement en arrière-plan
  res.status(200).json({ received: true });

  try {
    const lead = transformContact(payload);
    await sendToImmoFacile(lead);
  } catch (err) {
    log('error', 'Échec définitif de la transmission à ImmoFacile', {
      email : payload.email,
      error : err.message,
    });
  }
});

// ─── Démarrage ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log('info', `Middleware démarré sur le port ${PORT}`);
});
