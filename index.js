const express = require('express');
const app = express();

app.use(express.json());

// ─── Vérification de l'environnement au démarrage ───────────────────────────
const REQUIRED_ENV = ['IMMOFACILE_API_URL', 'IMMOFACILE_API_KEY', 'WEBHOOK_SECRET'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Variable d'environnement manquante : ${key}`);
    process.exit(1);
  }
}

// ─── Utilitaire de log ───────────────────────────────────────────────────────
function log(level, message, data = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data
  }));
}

// ─── Transformation Brevo → ImmoFacile ──────────────────────────────────────
function transformContact(brevoPayload) {
  const attr = brevoPayload.attributes || {};
  return {
    firstName  : attr.PRENOM      || null,
    lastName   : attr.NOM         || null,
    email      : brevoPayload.email || null,
    phone      : attr.TELEPHONE   || null,
    source     : attr.SOURCE      || 'brevo',
    project: {
      type   : attr.TYPE_PROJET  || null,   // achat / vente / location
      budget : attr.BUDGET       || null,
      city   : attr.VILLE        || null,
    },
    notes      : attr.NOTES       || null,
    receivedAt : new Date().toISOString(),
  };
}

// ─── Envoi vers ImmoFacile avec retry ───────────────────────────────────────
async function sendToImmoFacile(lead, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 2000;

  try {
    const response = await fetch(process.env.IMMOFACILE_API_URL, {
      method : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key'   : process.env.IMMOFACILE_API_KEY,  // adapte le nom du header si besoin
      },
      body: JSON.stringify(lead),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`ImmoFacile a répondu ${response.status} : ${body}`);
    }

    const result = await response.json().catch(() => ({}));
    log('info', 'Lead transmis avec succès à ImmoFacile', {
      email   : lead.email,
      attempt,
      immoId  : result.id || null,
    });
    return result;

  } catch (err) {
    log('warn', `Tentative ${attempt}/${MAX_ATTEMPTS} échouée`, {
      email  : lead.email,
      error  : err.message,
    });

    if (attempt < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      return sendToImmoFacile(lead, attempt + 1);
    }

    throw err; // toutes les tentatives épuisées
  }
}

// ─── Route de santé (Scalingo l'utilise pour vérifier que l'app tourne) ─────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'brevo-immofacile-middleware' });
});

// ─── Webhook principal ───────────────────────────────────────────────────────
app.post('/webhook/brevo', async (req, res) => {

  // 1. Vérification du secret partagé (header envoyé par Brevo)
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    log('warn', 'Tentative sans secret valide', { ip: req.ip });
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const payload = req.body;

  // 2. Validation minimale du payload
  if (!payload || !payload.email) {
    log('warn', 'Payload invalide reçu (email manquant)', { payload });
    return res.status(400).json({ error: 'Email manquant dans le payload' });
  }

  log('info', 'Webhook Brevo reçu', { email: payload.email, source: payload.attributes?.SOURCE });

  // 3. Transformation + envoi (réponse immédiate à Brevo, traitement en arrière-plan)
  res.status(200).json({ received: true });

  try {
    const lead = transformContact(payload);
    await sendToImmoFacile(lead);
  } catch (err) {
    log('error', 'Échec définitif de la transmission à ImmoFacile', {
      email : payload.email,
      error : err.message,
    });
    // Le lead est perdu ici — voir README pour mettre en place une alerte email
  }
});

// ─── Démarrage ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log('info', `Middleware démarré sur le port ${PORT}`);
});
