'use strict';
const nodemailer = require('nodemailer');

let transport;
function getTransport() {
  if (!transport && process.env.SMTP_HOST) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_PORT || 465) === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
  }
  return transport;
}

const TEXTS = {
  verify: {
    fr: ['Votre code Cruch Finder', 'Votre code de confirmation est : {code}\n\nIl est valable 1 heure. Si vous n\'avez pas créé de compte, ignorez ce message.'],
    en: ['Your Cruch Finder code', 'Your confirmation code is: {code}\n\nIt is valid for 1 hour. If you did not create an account, ignore this message.'],
    de: ['Ihr Cruch-Finder-Code', 'Ihr Bestätigungscode lautet: {code}\n\nEr ist 1 Stunde gültig. Wenn Sie kein Konto erstellt haben, ignorieren Sie diese Nachricht.'],
    it: ['Il tuo codice Cruch Finder', 'Il tuo codice di conferma è: {code}\n\nÈ valido per 1 ora. Se non hai creato un account, ignora questo messaggio.'],
  },
  reset: {
    fr: ['Réinitialisation de votre mot de passe', 'Votre code de réinitialisation est : {code}\n\nIl est valable 1 heure. Si vous n\'avez rien demandé, ignorez ce message : votre mot de passe reste inchangé.'],
    en: ['Reset your password', 'Your reset code is: {code}\n\nIt is valid for 1 hour. If you did not ask for this, ignore this message: your password is unchanged.'],
    de: ['Passwort zurücksetzen', 'Ihr Code zum Zurücksetzen lautet: {code}\n\nEr ist 1 Stunde gültig. Wenn Sie nichts angefordert haben, ignorieren Sie diese Nachricht.'],
    it: ['Reimposta la password', 'Il tuo codice di reimpostazione è: {code}\n\nÈ valido per 1 ora. Se non hai richiesto nulla, ignora questo messaggio.'],
  },
};

async function sendCode(to, kind, code, lang = 'fr') {
  const [subject, body] = (TEXTS[kind][lang] || TEXTS[kind].fr);
  const text = body.replace('{code}', code);
  const t = getTransport();
  if (!t) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[mail:dev] ${kind} -> ${to} : ${code}`);
      return;
    }
    throw new Error('SMTP non configuré');
  }
  await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
}

module.exports = { sendCode };
