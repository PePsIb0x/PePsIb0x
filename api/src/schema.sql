-- Cruch Finder : schéma MySQL 8 / MariaDB 10.6+ (Hostinger), équivalent de 0001 + 0002.
-- Appliqué au démarrage de l'API ; chaque instruction est idempotente.
-- Toutes les dates sont en UTC.

CREATE TABLE IF NOT EXISTS app_settings (
  id TINYINT PRIMARY KEY,
  match_threshold INT NOT NULL DEFAULT 50,
  min_common_answers INT NOT NULL DEFAULT 120,
  min_item_users INT NOT NULL DEFAULT 20,
  bonus_per_category INT NOT NULL DEFAULT 2,
  bonus_max INT NOT NULL DEFAULT 6,
  CHECK (id = 1),
  CHECK (match_threshold BETWEEN 0 AND 100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO app_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  email_verified_at DATETIME NULL,
  last_sign_in_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Modération : jamais modifiable par l'utilisateur (règle 1)
CREATE TABLE IF NOT EXISTS account_status (
  user_id CHAR(36) PRIMARY KEY,
  suspended TINYINT(1) NOT NULL DEFAULT 0,
  reason VARCHAR(500) NULL,
  last_refresh_at DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Codes à 6 chiffres (vérification d'e-mail, récupération), stockés hachés, 5 essais, 1 h
CREATE TABLE IF NOT EXISTS auth_codes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  kind ENUM('verify','reset') NOT NULL,
  code_hash CHAR(64) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX auth_codes_user (user_id, kind, id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Jetons de rafraîchissement opaques, hachés, rotation à chaque usage
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash CHAR(64) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX refresh_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS profiles (
  user_id CHAR(36) PRIMARY KEY,
  pseudo VARCHAR(30) NOT NULL,
  birth_date DATE NOT NULL,
  gender VARCHAR(20) NOT NULL,
  country_code CHAR(2) NOT NULL,
  city_name VARCHAR(120) NOT NULL,
  lat DECIMAL(6,2) NOT NULL,
  lon DECIMAL(6,2) NOT NULL,
  seeks JSON NOT NULL,
  age_ranges JSON NOT NULL,
  max_km INT NOT NULL DEFAULT 50,
  relation VARCHAR(20) NOT NULL,
  marital_status VARCHAR(20) NOT NULL DEFAULT 'single',
  kids VARCHAR(20) NOT NULL DEFAULT 'none',
  kids_ok JSON NOT NULL,
  family_project VARCHAR(20) NOT NULL,
  project_ok JSON NOT NULL,
  must_have JSON NOT NULL,
  bio VARCHAR(500) NULL,
  lang VARCHAR(5) NOT NULL DEFAULT 'fr',
  questionnaire_done_at DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX profiles_done (questionnaire_done_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS questions (
  id INT PRIMARY KEY,
  module_id VARCHAR(20) NOT NULL,
  module_name VARCHAR(120) NOT NULL,
  weight INT NOT NULL DEFAULT 1,
  position INT NOT NULL,
  text VARCHAR(500) NOT NULL,
  tag VARCHAR(120) NOT NULL,
  slug VARCHAR(80) NOT NULL,
  mode ENUM('sim','risk','avoid','seek') NOT NULL DEFAULT 'sim',
  cross_id INT NULL,
  `sensitive` VARCHAR(40) NULL,
  UNIQUE KEY questions_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 0 = « préfère ne pas répondre » : compte comme réponse, jamais dans le score
CREATE TABLE IF NOT EXISTS answers (
  user_id CHAR(36) NOT NULL,
  question_id INT NOT NULL,
  value TINYINT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, question_id),
  INDEX answers_question (question_id, user_id),
  CHECK (value BETWEEN 0 AND 5),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES questions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Journal des consentements, jamais modifié
CREATE TABLE IF NOT EXISTS consents (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  purpose ENUM('terms','sensitive_data','connector','ads_personalized') NOT NULL,
  scope VARCHAR(40) NULL,
  granted TINYINT(1) NOT NULL,
  text_version VARCHAR(20) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX consents_user (user_id, purpose, scope, id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Centres d'intérêt dérivés des imports (jamais les fichiers bruts), 12 mois
CREATE TABLE IF NOT EXISTS user_interests (
  user_id CHAR(36) NOT NULL,
  category VARCHAR(20) NOT NULL,
  item_key VARCHAR(120) NOT NULL,
  label VARCHAR(120) NOT NULL,
  source VARCHAR(20) NOT NULL,
  weight TINYINT NOT NULL DEFAULT 1,
  imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (user_id, category, item_key, source),
  INDEX user_interests_item (category, item_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Propositions : user_a < user_b pour éviter les doublons
CREATE TABLE IF NOT EXISTS proposals (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_a CHAR(36) NOT NULL,
  user_b CHAR(36) NOT NULL,
  score INT NOT NULL,
  qscore INT NULL,
  bonus INT NOT NULL DEFAULT 0,
  common_tags JSON NOT NULL,
  common_count INT NOT NULL,
  module_scores JSON NULL,
  shared JSON NOT NULL,
  decision_a ENUM('pending','accepted','refused') NOT NULL DEFAULT 'pending',
  decision_b ENUM('pending','accepted','refused') NOT NULL DEFAULT 'pending',
  matched_at DATETIME NULL,
  closed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY proposals_pair (user_a, user_b),
  INDEX proposals_user_b (user_b),
  CHECK (user_a < user_b),
  FOREIGN KEY (user_a) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (user_b) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  proposal_id BIGINT NOT NULL,
  author CHAR(36) NOT NULL,
  body VARCHAR(2000) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX messages_proposal (proposal_id, id),
  INDEX messages_author (author, created_at),
  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE,
  FOREIGN KEY (author) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blocks (
  blocker CHAR(36) NOT NULL,
  blocked CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (blocker, blocked),
  INDEX blocks_blocked (blocked),
  FOREIGN KEY (blocker) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (blocked) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reports (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  reporter CHAR(36) NOT NULL,
  reported CHAR(36) NOT NULL,
  proposal_id BIGINT NULL,
  reason VARCHAR(20) NOT NULL,
  details VARCHAR(1000) NULL,
  status ENUM('open','reviewed','closed') NOT NULL DEFAULT 'open',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reporter) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reported) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
