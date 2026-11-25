# Cruch Finder – contrat d'API (v1)

Client : l'APK Android (pont natif) et la version web/PWA. Le serveur : API Node.js + MySQL sur Hostinger.
Référence de la logique métier : `app/supabase/migrations/0002_securite_auth_donnees.sql` (règles, contrôles, calcul du score)
et `questions.json` v3 (modes de score, questions croisées, questions sensibles).

## Généralités

- Base : `https://api.optima-tools.ch/v1` (configurable dans l'app). HTTPS uniquement.
- Corps JSON en UTF-8. En-tête `Authorization: Bearer <access_token>` sur tout sauf `/auth/*` (hors `logout`).
- Erreurs : statut HTTP + `{"error":"<code>","message":"<texte>"}`. Codes attendus par l'app :
  `invalid_credentials`, `email_not_confirmed`, `user_already_exists`, `otp_expired`, `weak_password`,
  `rate_limited` (429), `not_authenticated` (401, déclenche un refresh), `chat_closed`, `proposal_not_found`,
  `terms_required`, `profile_required`, `invalid_reason`.
- Limites conseillées : 5 tentatives de connexion / 15 min / IP+e-mail, 3 envois de code / heure / e-mail,
  30 messages / minute / utilisateur, `refresh_my_proposals` 1 fois / minute.

## Authentification (e-mail vérifié, mot de passe, récupération)

Mot de passe : 10 à 72 caractères, au moins une lettre et un chiffre, haché en Argon2id (ou bcrypt coût ≥ 12).
Codes : 6 chiffres, valables 1 h, 5 essais max, stockés hachés, usage unique.
Jetons : access JWT 15 min (HS256 ou RS256, secret dans une variable d'environnement), refresh opaque 30 jours,
stocké haché, rotation à chaque refresh, révocation au logout et à la réinitialisation du mot de passe.

| Méthode et chemin | Corps | Réponse |
|---|---|---|
| `POST /auth/signup` | `{email, password}` | `201 {"needsVerification":true}`. Toujours la même réponse, même si l'e-mail existe (pas d'énumération). Envoie le code. |
| `POST /auth/verify` | `{email, code}` | `200 Tokens` (confirme l'e-mail) |
| `POST /auth/resend` | `{email}` | `204` |
| `POST /auth/login` | `{email, password}` | `200 Tokens`, ou `401 invalid_credentials`, ou `403 email_not_confirmed` |
| `POST /auth/refresh` | `{refresh_token}` | `200 Tokens` |
| `POST /auth/recover` | `{email}` | `204` toujours. Envoie un code si le compte existe. |
| `POST /auth/reset` | `{email, code, password}` | `200 Tokens` (nouveau mot de passe, autres sessions révoquées) |
| `POST /auth/logout` | `{refresh_token}` + Bearer | `204` |

`Tokens` = `{"access_token":"…","refresh_token":"…","expires_in":900,"user":{"id":"<uuid>","email":"…"}}`

## Appels métier : `POST /rpc/<nom>` (Bearer obligatoire)

Les noms et les formats reprennent exactement les fonctions de la migration 0002. Toute écriture passe par ces appels.

| Nom | Paramètres | Réponse |
|---|---|---|
| `sync_state` | `{"p":{consents:[{purpose,scope,granted,version}], profile:{…}, answers:[[n,v],…], interests:{source:[{category,key,label,weight}]}}}` | `{"answers":180,"questionnaire_done":true}` |
| `record_consent` | `{p_purpose, p_scope, p_granted, p_version}` | `null` |
| `refresh_my_proposals` | `{}` | nombre créé, ou `-1` si limité |
| `get_proposals` | `{}` | `[Proposal]` |
| `decide` | `{p_id, d:"accepted"|"refused"}` | `{"id":7,"matched":true,"closed":false}` |
| `get_messages` | `{p_id, p_after}` | `[{"id":1,"me":false,"body":"…","at":"ISO"}]` (200 max) |
| `send_message` | `{p_id, p_body}` (1 à 2000 caractères) | `{"id":2,"me":true,"body":"…","at":"ISO"}` |
| `block_proposal` | `{p_id}` | `null` |
| `report_proposal` | `{p_id, p_reason, p_details}` | `null` |
| `get_my_state` | `{}` | `{profile|null, answers:[[n,v]], consents:{terms,sensitive,ads}, interest_sources:[…]}` |
| `export_my_data` | `{}` | objet JSON complet (RGPD art. 15 et 20) |
| `delete_my_account` | `{}` | `null` (effacement en cascade immédiat) |

### `profile` envoyé par l'app (codes, jamais de texte libre sauf pseudo et ville)

```json
{"pseudo":"Alex","birth_date":"1995-04-12","gender":"homme","country_code":"CH","city_name":"Lausanne",
 "lat":46.52,"lon":6.63,"seeks":["femme","femme_trans"],"age_ranges":["25-29","30-39"],"max_km":60,
 "relation":"serieuse","marital_status":"single","kids":"none","kids_ok":["any"],
 "family_project":"wants","project_ok":["wants","unsure"],"must_have":["max60"],"lang":"fr"}
```

- `gender` / `seeks` : `femme, homme, non_binaire, femme_trans, homme_trans, genderfluid, agenre, queer, intersexe, autre`
- `age_ranges` : `18-24, 25-29, 30-39, 40-49, 50-69, 70+` ; `relation` : `serieuse, legere, indecis`
- `marital_status` : `single, divorced, widowed` ; `kids` : `none, dependent, shared, adult` ; `kids_ok` ⊂ `any, none, with`
- `family_project` : `wants, no, unsure, complete` ; `project_ok` ⊂ `any` + ces 4 ; `must_have` ⊂ `max60, same_relation, non_smoker`
- Âge ≥ 18 ans obligatoire. Coordonnées arrondies à 0,01° (centre de la ville, jamais le GPS).

### Réponses

`answers` : `[[numéro 1-180, valeur 0-5]]`, 0 = « préfère ne pas répondre ». Sans consentement `sensitive_data`,
les 5 questions sensibles sont forcées à 0 côté serveur. `questionnaire_done` quand les 180 sont présentes.

### Centres d'intérêt

`category` ∈ `music, listening, sport, series, books, authors, follows` ; `source` ∈ `google, strava, netflix, instagram,
facebook, tiktok, snapchat, disney, prime, spotify, deezer, letterboxd, goodreads` ; `weight` 1 à 3 ; 600 éléments max par source.
Enregistrés seulement si le dernier consentement `connector`/`source` est accordé. Expiration 12 mois.

### `Proposal` renvoyée par `get_proposals`

```json
{"id":7,"pseudo":"Nora","age":30,"gender":"femme","city":"Vevey","relation":"serieuse","bio":"…","km":18,
 "score":82,"qscore":78,"bonus":4,"common_tags":["Humour","Voyages","Patience"],"common_count":170,
 "modules":[80,70,90,75,85,60],"shared":{"music":["Angèle"]},"my_decision":"pending","matched":false}
```

Jamais l'e-mail, les réponses, les imports bruts ni la décision de l'autre avant le match. Exclure : propositions
fermées, refusées par moi, personnes bloquées dans un sens ou l'autre, comptes suspendus.

## Calcul du score (côté serveur uniquement)

Voir `private.pair_score` dans 0002. Résumé :
- Par question, `sim` : `1 − |a−b|/4` ; `risk` : idem, divisé par 2 si les deux ≥ 4 ;
  `avoid` / `seek` (questions croisées, champ `cross`) : `1 − max(pénalité A→B, pénalité B→A)` avec
  `pénalité = max(0, pref−3)/2 × (trait−1)/4` (avoid) ou `× (5−trait)/4` (seek). Les réponses 0 sont ignorées.
- `qscore` = moyenne pondérée par le poids du module (×2 pour Relation et valeurs, Famille et enfants).
- Au moins 120 questions comparables, sinon pas de proposition. Proposition dès `score ≥ 50`.
- `bonus` = 2 points par catégorie d'intérêt en commun, 6 max, en ne comptant que les éléments détenus par
  au moins 20 utilisateurs (k-anonymat). `score = min(100, qscore + bonus)`.
- `common_tags` : 3 meilleures questions `sim`, jamais une question sensible.
- Filtres éliminatoires dans les deux sens : genres, âges, distance (min des deux rayons, 60 km si `max60`),
  `same_relation`, enfants acceptés, projet familial, `non_smoker` (réponse « Je fume ou je vapote » ≥ 4 exclue).

## Règles de sécurité à reproduire

1. Un utilisateur ne modifie jamais `suspended`, les dates de consentement ou `questionnaire_done_at` lui-même.
2. Le calcul des propositions n'est déclenchable que pour soi (`refresh_my_proposals`), jamais pour un autre id.
3. Un refus après un match ferme la proposition (`closed_at`) et le chat.
4. Le blocage ferme la proposition et masque la personne dans les deux sens.
5. Retrait d'un consentement : `sensitive_data` remet les 5 réponses à 0 ; `connector` efface les intérêts de la source.
6. Conservation : intérêts 12 mois, messages 30 jours après fermeture (sauf signalement ouvert), comptes inactifs 24 mois.
7. Secrets (JWT, MySQL, SMTP) uniquement en variables d'environnement, jamais dans le dépôt ni dans l'app.

## Connexion Google et Apple (ajout v1.1, déployé)

| Méthode et chemin | Corps | Réponse |
|---|---|---|
| `POST /auth/google` | `{id_token, nonce?}` | `200 Tokens` |
| `POST /auth/apple` | `{id_token, nonce, name?}` | `200 Tokens` |

La réponse de ces deux routes ajoute `"created": true` quand le compte vient d’être créé (sinon `false`) : l’app fait alors accepter les CGU et l’âge avant le profil.

- Google : signature vérifiée avec les clés JWKS de Google, `iss` = `accounts.google.com`, `aud` ∈ `GOOGLE_CLIENT_IDS`,
  `exp`, `email_verified` vrai, `nonce` égal s'il est fourni.
- Apple : clés JWKS d'Apple, `iss` = `https://appleid.apple.com`, `aud` ∈ `APPLE_CLIENT_IDS` (`ch.optimatools.cruchfinder`),
  le claim `nonce` doit valoir le SHA-256 hexadécimal du `nonce` envoyé.
- Compte identifié par (fournisseur, `sub`). Sinon rattaché au compte qui a le même e-mail ; si ce compte n'avait jamais
  confirmé son e-mail, son mot de passe est invalidé et ses sessions révoquées. Sinon un compte est créé, e-mail confirmé.
- Erreurs : `invalid_token` (401), `email_not_verified` (403), `provider_not_configured` (503 tant que la liste des
  identifiants clients du fournisseur est vide), `rate_limited` (429, 30 / 15 min / IP).
- `delete_my_account` efface aussi ces identités ; `export_my_data` les liste dans `sign_in_providers`.

## Distance et GPS (v1.2, déployé)

- `max_km` : 0 à 20000 ; 0 = monde entier. Filtre mutuel : le plus petit des deux rayons (0 = illimité ; `max60` plafonne à 60).
- Consentement `purpose: "location"` (facultatif). Son retrait efface la position.
- `POST /rpc/update_location` `{p_lat, p_lon}` → `null`. `403 consent_required` sans consentement, `429 rate_limited` si
  moins de 10 min depuis la dernière mise à jour. Arrondi serveur à 0,02° (~2 km), table privée, jamais renvoyée à
  personne, effacée après 7 jours sans mise à jour. Sans GPS frais, la position de la ville est utilisée.
- `get_proposals` : `km` est remplacé par `dist_band` ∈ `lt5, 5-20, 20-50, 50-200, 200-1000, gt1000`, plus `closer`
  (true si la tranche est plus proche qu'au précédent appel de la même personne) et `proximity`
  (3 pour lt5 et 5-20, 2 pour 20-50, 1 pour 50-200, 0 au-delà). `score = min(100, qscore + bonus + proximity)`.
- `get_my_state.consents.location` ; `export_my_data.location` = `{lat, lon, updated_at}` ou `null`.
