// ===== CapNaval — serveur Node.js + ws (pour Render, pas de Durable Object) =====
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const DEFAULT_GRID_SIZE_MIN = 8;
const DEFAULT_GRID_SIZE_MAX = 16;
const MUD_COOLDOWN_MULT_DEFAULT = 2;
const SPEED_COOLDOWN_MULT = 0.5;
const RESIST_DAMAGE_MULT = 0.5;
const BUFF_DURATION_SEC_DEFAULT = 10;
const RECONNECT_GRACE_MS = 90000; // 90s pour se reconnecter avant d'être retiré pour de bon
const SHRINK_PRESETS_SEC = { slow: 30, medium: 18, fast: 9 };
const SHRINK_MODES = ["slow", "medium", "fast", "onKO", "custom"];
const SHRINK_INITIAL_RADIUS = 6;
const SHRINK_MIN_RADIUS = 1;
const SHRINK_DAMAGE_PER_SEC = 6;
const HILL_TICK_MS = 2000;
const DEFAULT_GRID_SIZE = 12;
const BREAKABLE_WALL_HP = 30;
const BREAKABLE_WALL_DAMAGE_PER_HIT = 15;
const HEAL_TILE_PER_SEC = 6;
const TELEPORT_TILE_COOLDOWN_MS = 5000;
const LIGHTNING_ROD_RADIUS = 1;
const LIGHTNING_ROD_BONUS_DAMAGE = 20;

const MAP_MODIFIERS = {
  meteorRain: { label: "Pluie de météorites", desc: "Des météorites tombent du ciel de temps en temps.", icon: "☄️" },
  storm:      { label: "Orage",               desc: "La foudre frappe un joueur au hasard régulièrement.", icon: "🌩️" },
  earthquakeMod: { label: "Séisme",           desc: "La terre tremble souvent, petits dégâts à tous.",    icon: "🌍" },
  acidRainMod:   { label: "Pluie acide",      desc: "De l'acide tombe en continu, mais rarement.",        icon: "🧪" },
  cemetery:      { label: "Cimetière",        desc: "Des ombres sans nom surgissent et explosent au contact.", icon: "🧟" },
};
// Réglages fins par modificateur (bornes de sécurité incluses) : fréquence en
// occurrences par minute, plus quelques champs propres à chaque modificateur.
const MODIFIER_TUNABLE_RANGES = {
  meteorRain:    { perMinute: [0.1, 120, 4.5], damage: [0, 300, 18] },
  storm:         { perMinute: [0.1, 120, 4],   damage: [0, 300, 14] },
  earthquakeMod: { perMinute: [0.1, 120, 3],   damage: [0, 300, 6] },
  acidRainMod:   { perMinute: [0.1, 120, 2.2], damage: [0, 300, 5], size: [1, 12, 2] },
  cemetery:      { perMinute: [0.1, 120, 3.3], zombieHp: [1, 2000, 50], explosionDamage: [0, 300, 22] },
};
function defaultModifierSettings() {
  const out = {};
  for (const [id, fields] of Object.entries(MODIFIER_TUNABLE_RANGES)) {
    out[id] = {};
    for (const [field, [, , def]] of Object.entries(fields)) out[id][field] = def;
  }
  return out;
}
// Intervalle (min, max) en secondes déduit du réglage "par minute" (±30% pour éviter un rythme trop prévisible).
function modifierIntervalSec(room, id) {
  const perMinute = (room.modifierSettings[id] && room.modifierSettings[id].perMinute) || MODIFIER_TUNABLE_RANGES[id].perMinute[2];
  const avg = 60 / perMinute;
  return [avg * 0.7, avg * 1.3];
}
const ZOMBIE_MAX_ALIVE = 3;
const ZOMBIE_HP = 50;
const ZOMBIE_DAMAGE_PER_HIT = 20;
const ZOMBIE_EXPLOSION_DAMAGE = 22;
const DEFAULT_TELEGRAPH_MS = 1300;
const NUKE_RESOLVE_DELAY_MS = 2000; // dégâts appliqués juste au moment de la vraie explosion (après le faux départ), côté client
const DEFAULT_POWERUP_INTERVAL_SEC = 14;
const POWERUP_TYPES = ["heal", "resist", "speed"];
const TREASURE_SPAWN_INTERVAL_SEC = 4;
const TREASURE_MAX_ON_MAP = 6;
const HILL_MOVE_INTERVAL_SEC = 14; // mode Zone mobile : rythme de déplacement de la zone à tenir
const INFECTION_TAG_RADIUS = 1; // distance (Chebyshev) à laquelle un joueur infecté contamine les autres
const ROOM_IDLE_CLEANUP_MS = 1000 * 60 * 60 * 3;
const MAX_PLAYERS_HARD_CAP = 6;
const BOT_DIFFICULTIES = ["easy", "medium", "hard"];
const BOT_DODGE_CHANCE = { easy: 0.15, medium: 0.5, hard: 1 };
const BOT_ATTACK_DELAY_MS = { easy: [900, 2400], medium: [700, 1900], hard: [250, 700] };
const BOT_START_GRACE_MS = 3200; // ne bouge pas tant que le décompte 3-2-1-GO joue côté client
const BOT_RANDOM_MOVE_CHANCE = 0.45; // en dehors de toute fuite : bouge au hasard, ou reste immobile
const BOT_NAMES = [
  "Capitaine Rouille", "Amiral Patate", "Moussaillon Fou", "Barbe-Jus", "Grand Timonier",
  "Sardine Enragée", "Pieuvre Grognon", "Mousse Salée", "Vieux Loup", "Pirate du Dimanche",
  "Krill Tueur", "Boussole Cassée", "Second Couteau", "Marin d'Eau Douce", "Tempête de Poche",
];
const BOT_FLEE_ATTACKS = new Set(["charge", "shockwave"]); // attaques de mêlée à fuir

// ---- Valeurs par défaut des paramètres réglables par l'hôte ----
const DEFAULT_MOVE_COOLDOWN_MS = 800;
const DEFAULT_ATTACK_WINDOW_SEC = 12;
const DEFAULT_TURN_GAP_SEC = 2.5;
const DEFAULT_START_HP = 100;
const DEFAULT_RESPAWN_DELAY_SEC = 4;
const DEFAULT_RESPAWN_HP_PERCENT = 50;
const DEFAULT_DAMAGE_MULTIPLIER = 1;
const DEFAULT_BARREL_DAMAGE = 22;
const DEFAULT_POWERUP_MAX_ON_MAP = 3;

const COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#f97316"];
const TEAM_COLORS = { A: "#ef4444", B: "#3b82f6" };

const ATTACKS = [
  { id: "meteor",       name: "Météorite",         desc: "Frappe une zone 3x3 choisie",                 target: "zone", size: 3, damage: 25, telegraphMs: 1300 },
  { id: "airstrike",    name: "Frappe aérienne",   desc: "3 impacts en rafale dans une zone 5x5, instantané", target: "zone", size: 5, damage: 15, hits: 3, random: true, instant: true, staggered: true },
  { id: "meteorShower", name: "Pluie de météores", desc: "5 impacts en rafale dans une zone 6x6, instantané", target: "zone", size: 6, damage: 14, hits: 5, random: true, instant: true, staggered: true },
  { id: "napalm",       name: "Chute de napalme",  desc: "Choisis une case : un brasier 3x3 tourne dans les 4 coins d'une zone 5x5, laisse des flammes, instantané — rarissime", target: "cell", damage: 16, hits: 4, subSize: 3, offsets: [[-1,-1],[1,-1],[1,1],[-1,1]], instant: true, staggered: true, leavesFire: true, fireDamage: 7, fireTicks: 4, weight: 0.12 },
  { id: "acidRain",     name: "Pluie acide",       desc: "Choisis une zone 7x7 : ~10 cases deviennent toxiques 10s, au hasard", target: "zone", size: 7, acidRain: true, drops: 10, dropDamage: 6, dropTicks: 10, forceTelegraph: true, telegraphMs: 1400, weight: 0.35 },
  { id: "nuke",         name: "Bombe nucléaire",   desc: "Rase toute la carte, instantané — secrète, code requis", target: "self", damage: 999, instant: true, nuke: true, weight: 0, secret: true },
  { id: "snipe",        name: "Tir de précision",  desc: "Dégâts élevés sur une case, instantané",       target: "cell", damage: 35, instant: true },
  { id: "laser",        name: "Rayon laser",       desc: "Frappe une ligne entière, instantané",         target: "line", damage: 16, instant: true },
  { id: "chainLightning", name: "Chaîne d'éclairs", desc: "Frappe une case (ou un joueur) : l'éclair s'étend en zone puis rebondit sur les joueurs proches, instantané", target: "cell", damage: 18, chain: true, chainHops: 3, chainFalloff: 0.75, chainSplashRadius: 1, instant: true },
  { id: "shockwave",    name: "Onde de choc",      desc: "Frappe toutes les cases autour de toi, instantané", target: "self", damage: 18, instant: true },
  { id: "earthquake",   name: "Séisme",            desc: "Secoue toute la carte : petits dégâts et déplace tout le monde d'une case au hasard, instantané", target: "self", damage: 6, earthquake: true, instant: true },
  { id: "gunline",      name: "Rafale",            desc: "Mitraille une ligne, stoppée par les murs",   target: "line", damage: 12, telegraphMs: 1300 },
  { id: "grenade",      name: "Grenade",           desc: "Explosion sur une zone 2x2",                   target: "zone", size: 2, damage: 20, telegraphMs: 1100 },
  { id: "arrow",        name: "Flèche perforante", desc: "Choisis une direction : transperce tout, même les murs, instantané", target: "direction", damage: 16, distance: 12, moveSelf: false, piercesWalls: true, instant: true },
  { id: "charge",       name: "Charge",            desc: "Fonce en ligne droite sur 3 cases, instantané, un peu plus rapide", target: "direction", damage: 22, distance: 3, moveSelf: true, instant: true },
  { id: "tornado",      name: "Tornade",           desc: "Aspire les joueurs vers le centre d'une zone 3x3", target: "zone", size: 3, damage: 10, pull: true, telegraphMs: 1300 },
  { id: "net",          name: "Filet",             desc: "Immobilise le joueur touché 3 secondes",       target: "cell", damage: 5, root: true, rootMs: 3000, telegraphMs: 1000 },
  { id: "frost",        name: "Vague de givre",    desc: "Ralentit et blesse une zone 3x3, laisse une trace glacée",   target: "zone", size: 3, damage: 8, slow: true, slowMs: 1500, traceTicks: 6, telegraphMs: 1200 },
  { id: "mine",         name: "Piège explosif",    desc: "Pose une mine invisible sur une case",         target: "cell", damage: 30, trap: true },
  { id: "heal",         name: "Soin d'urgence",    desc: "Soigne toi ou un allié proche",                target: "ally", heal: 25 },
  { id: "healZone",     name: "Zone de soin",      desc: "Choisis une zone 3x3 qui soigne au fil du temps", target: "zone", size: 3, heal: 10, ticks: 4, healZone: true, forceTelegraph: true, telegraphMs: 1200 },
  { id: "shield",       name: "Bouclier",          desc: "Absorbe la prochaine attaque reçue",           target: "self", shield: true },
  { id: "poison",       name: "Zone toxique",      desc: "Nuage toxique 3x3, dégâts chaque seconde",     target: "zone", size: 3, damage: 6, poison: true, ticks: 4, telegraphMs: 1300 },
  { id: "teleport",     name: "Téléportation",     desc: "Téléporte-toi n'importe où sur la carte",      target: "cell", teleport: true, range: 999 },
];

// Champs numériques qu'un hôte peut régler finement par attaque (bornes de sécurité incluses).
// Seuls les champs présents sur l'attaque d'origine sont proposés au client.
const TUNABLE_FIELD_RANGES = {
  damage: [0, 200], heal: [0, 150], size: [1, 9], ticks: [1, 20],
  slowMs: [200, 8000], rootMs: [200, 8000], traceTicks: [1, 15],
  distance: [1, 16], hits: [1, 10], telegraphMs: [200, 6000],
  fireDamage: [0, 50], fireTicks: [1, 12], dropDamage: [0, 50], dropTicks: [1, 20], drops: [1, 20],
  chainHops: [0, 6], chainFalloff: [0.1, 1], range: [1, 999],
};
function getAttackTunables(attack) {
  const out = {};
  for (const field of Object.keys(TUNABLE_FIELD_RANGES)) {
    if (attack[field] !== undefined) out[field] = attack[field];
  }
  return out;
}

const MODES = {
  survivor: { label: "Dernier survivant", desc: "Pas de respawn. Le dernier debout, ou la dernière équipe, gagne.", respawns: false },
  koHunt:   { label: "Chasse au K.O.",    desc: "Premier à X éliminations gagne, cumul d'équipe si activé.", respawns: true },
  kingHill: { label: "Roi de la case",    desc: "Reste sur la case centrale pour marquer des points. Premier à X points gagne.", respawns: true },
  chrono:   { label: "Chrono",            desc: "Partie limitée dans le temps. Le plus d'éliminations à la fin gagne, mort subite en cas d'égalité.", respawns: true },
  boss:     { label: "Chasse au Boss",    desc: "Un joueur (ou un bot) devient le Boss, bien plus costaud. Les autres doivent l'abattre avant qu'il ne les élimine tous. Pas de respawn.", respawns: false },
  ctf:      { label: "Capture du drapeau", desc: "2 équipes, 2 bases. Vole le drapeau adverse et ramène-le sur ta base pour marquer. Premier à X captures gagne.", respawns: true },
  zoneMobile:   { label: "Zone mobile",      desc: "Comme Roi de la case, mais la zone à tenir se déplace régulièrement sur la carte. Premier à X points gagne.", respawns: true },
  treasureHunt: { label: "Chasse au trésor", desc: "Des trésors apparaissent au hasard sur la carte. Premier à en ramasser X gagne.", respawns: true },
  escort:       { label: "Escorte",          desc: "Un joueur VIP tiré au sort doit survivre face aux autres jusqu'à la fin du temps imparti.", respawns: false },
  infection:    { label: "Infection",        desc: "Un joueur infecté au hasard doit s'approcher des autres pour les contaminer. Les humains encore sains à la fin du temps imparti gagnent, sauf si tout le monde est infecté avant.", respawns: false },
};

const MAPS = {
  open:    { label: "Terrain ouvert", desc: "Aucun obstacle.",                                  walls: 0,  barrels: 0,  mud: 0 },
  ruins:   { label: "Ruines",         desc: "Des murs pour se mettre à couvert.",                walls: 14, barrels: 4,  mud: 0 },
  swamp:   { label: "Marécage",       desc: "Des flaques de boue ralentissent les déplacements.",walls: 6,  barrels: 2,  mud: 12 },
  arsenal: { label: "Arsenal",        desc: "Beaucoup de tonneaux explosifs, réaction en chaîne.",walls: 8,  barrels: 14, mud: 0 },
  labo:    { label: "Labo",           desc: "Paratonnerres, téléporteurs et zones de soin.",     walls: 6,  barrels: 0,  mud: 0, teleport: 4, heal: 2, lightningRod: 3 },
  jardin:  { label: "Jardin",         desc: "Buissons où se cacher, et murs cassables.",         walls: 4,  barrels: 0,  mud: 0, bush: 8, breakable: 8 },
  custom:  { label: "Personnalisé",   desc: "Ta carte, conçue et enregistrée par toi.",          walls: 0,  barrels: 0,  mud: 0 },
};

function randInt(n) { return Math.floor(Math.random() * n); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function numOr(v, def) { const n = parseFloat(v); return Number.isFinite(n) ? n : def; }
function inBoundsGlobal(x, y, size) { return x >= 0 && y >= 0 && x < size && y < size; }
function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[randInt(chars.length)];
  return s;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

class Room {
  constructor(code) {
    this.code = code;
    this.status = "lobby"; // lobby | playing | ended
    this.players = {};
    this.hazards = [];
    this.powerups = [];
    this.obstacles = { walls: [], barrels: [], mud: [], heal: [], teleport: [], breakable: [], lightningRod: [], bush: [] };
    this.mapId = "open";
    this.gridSize = DEFAULT_GRID_SIZE;
    this.passiveRegenPerSec = 0;
    this.powerupsEnabled = true;
    this.powerupIntervalSec = DEFAULT_POWERUP_INTERVAL_SEC;
    this.powerupMaxOnMap = DEFAULT_POWERUP_MAX_ON_MAP;
    this.lastPowerupSpawn = 0;
    this.teamsEnabled = false;
    this.pushEnabled = true;
    this.shrinkEnabled = false;
    this.shrinkMode = "medium";
    this.shrinkIntervalSec = SHRINK_PRESETS_SEC.medium;
    this.shrinkRadius = SHRINK_INITIAL_RADIUS;
    this.lastShrinkAt = 0;
    this.isPublic = false;
    this.maxPlayers = MAX_PLAYERS_HARD_CAP;
    this.turn = null;
    this.hostId = null;
    this.timer = null;
    this.hillTimer = null;
    this.secondTimer = null;
    this.lastActivity = Date.now();
    this.lastAttackId = null;
    this.attacksRuntime = ATTACKS;
    this.bossId = null;
    this.bossHpMultiplier = 3;
    this.flags = [];
    this.fillBotCount = 0;
    this.fillBotDifficulty = "medium";
    this.activeTelegraphs = [];
    this.matchStartedAt = 0;
    this.mapModifiers = [];
    this.modifierSettings = defaultModifierSettings();
    this.modifierNextAt = {};
    this.zombies = [];
    this.turnQueue = [];
    this.pendingAttacks = new Set();

    // ---- Paramètres réglables par l'hôte ----
    this.moveCooldownMs = DEFAULT_MOVE_COOLDOWN_MS;
    this.attackWindowSec = DEFAULT_ATTACK_WINDOW_SEC;
    this.turnGapSec = DEFAULT_TURN_GAP_SEC;
    this.startingHP = DEFAULT_START_HP;
    this.respawnDelaySec = DEFAULT_RESPAWN_DELAY_SEC;
    this.respawnHpPercent = DEFAULT_RESPAWN_HP_PERCENT;
    this.damageMultiplier = DEFAULT_DAMAGE_MULTIPLIER;
    this.barrelDamage = DEFAULT_BARREL_DAMAGE;
    this.weaponNoRepeat = true;
    this.hideAttackFromOthers = true;
    this.twoWeaponHand = false;
    this.mineVisibleToAll = false;
    this.attackWeightOverrides = {}; // { attackId: multiplicateur } — taux de tirage par attaque
    this.telegraphMultiplier = 1;    // vitesse du clignotement d'esquive (plus bas = plus dur à esquiver)
    this.buffDurationSec = BUFF_DURATION_SEC_DEFAULT;
    this.mudSlowMultiplier = MUD_COOLDOWN_MULT_DEFAULT;
    this.spawnProtectionSec = 0;     // invulnérabilité temporaire après un (re)spawn

    this.mode = null;
    this.config = {};
    this.chronoEndAt = null;
    this.suddenDeath = false;
    this.suddenDeathIds = new Set();
    this.winner = null;
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const p of Object.values(this.players)) {
      if (p.ws && p.ws.readyState === 1) p.ws.send(data);
    }
  }

  // Diffuse l'état public, en cachant l'arme du tour en cours aux autres joueurs
  // si l'option est active (activée par défaut) — chacun ne voit que sa propre arme.
  broadcastState() {
    const base = this.publicState();
    if (!this.hideAttackFromOthers || !base.turn) { this.broadcast(base); return; }
    const activeId = base.turn.playerId;
    const hidden = { ...base, turn: { playerId: base.turn.playerId, attackId: null, attackName: null, altAttackId: null, altAttackName: null, deadline: base.turn.deadline } };
    const fullJson = JSON.stringify(base);
    const hiddenJson = JSON.stringify(hidden);
    for (const p of Object.values(this.players)) {
      if (!p.ws || p.ws.readyState !== 1) continue;
      p.ws.send(p.id === activeId ? fullJson : hiddenJson);
    }
  }

  publicState() {
    return {
      type: "state",
      status: this.status,
      players: Object.values(this.players).map(({ ws, clientId, disconnectedAt, ...rest }) => rest),
      hazards: this.hazards.map(h => h.type === "mine" ? { x: h.x, y: h.y, type: "mine", ownerId: h.ownerId } : h),
      powerups: this.powerups,
      treasures: this.treasures || [],
      escortId: this.escortId || null,
      infectionEndAt: this.infectionEndAt || null,
      obstacles: this.obstacles,
      mapId: this.mapId,
      mapLabel: MAPS[this.mapId] ? MAPS[this.mapId].label : null,
      teamsEnabled: this.teamsEnabled,
      pushEnabled: this.pushEnabled,
      moveCooldownMs: this.moveCooldownMs,
      mudSlowMultiplier: this.mudSlowMultiplier,
      mineVisibleToAll: this.mineVisibleToAll,
      teamColors: TEAM_COLORS,
      turn: this.turn ? {
        playerId: this.turn.playerId,
        attackId: this.turn.attack.id,
        attackName: this.turn.attack.name,
        altAttackId: this.turn.altAttack ? this.turn.altAttack.id : null,
        altAttackName: this.turn.altAttack ? this.turn.altAttack.name : null,
        deadline: this.turn.deadline,
      } : null,
      gridSize: this.gridSize,
      hostId: this.hostId,
      maxPlayers: this.maxPlayers,
      bossId: this.bossId,
      startingHP: this.startingHP,
      bossHpMultiplier: this.bossHpMultiplier,
      flags: this.flags,
      mapModifiers: this.mapModifiers,
      zombies: this.zombies,
      fillBotCount: this.fillBotCount,
      fillBotDifficulty: this.fillBotDifficulty,
      mode: this.mode,
      modeLabel: this.mode ? MODES[this.mode].label : null,
      config: this.config,
      roomConfig: {
        powerupsEnabled: this.powerupsEnabled,
        powerupIntervalSec: this.powerupIntervalSec,
        shrinkEnabled: this.shrinkEnabled,
        shrinkMode: this.shrinkMode,
        shrinkIntervalSec: this.shrinkIntervalSec,
        respawnDelaySec: this.respawnDelaySec,
        respawnHpPercent: this.respawnHpPercent,
        attackWindowSec: this.attackWindowSec,
        turnGapSec: this.turnGapSec,
        damageMultiplier: this.damageMultiplier,
        barrelDamage: this.barrelDamage,
        powerupMaxOnMap: this.powerupMaxOnMap,
        weaponNoRepeat: this.weaponNoRepeat,
        hideAttackFromOthers: this.hideAttackFromOthers,
        twoWeaponHand: this.twoWeaponHand,
        telegraphMultiplier: this.telegraphMultiplier,
        buffDurationSec: this.buffDurationSec,
        spawnProtectionSec: this.spawnProtectionSec,
        passiveRegenPerSec: this.passiveRegenPerSec,
        attackWeightOverrides: this.attackWeightOverrides,
        modifierOverrides: this.modifierSettings,
      },
      chronoEndAt: this.chronoEndAt,
      matchStartedAt: this.matchStartedAt,
      suddenDeath: this.suddenDeath,
      hillCells: this.hillCells().map(([x, y]) => ({ x, y })),
      winner: this.winner,
      isPublic: this.isPublic,
      shrink: { enabled: this.shrinkEnabled, radius: this.shrinkRadius, center: this.shrinkCenter(), mode: this.shrinkMode, intervalSec: this.shrinkIntervalSec },
    };
  }

  pushLog(message) { this.broadcast({ type: "log", message }); }

  // ---- Obstacles ----
  isWall(x, y) { return this.obstacles.walls.some(w => w.x === x && w.y === y); }
  isBarrel(x, y) { return this.obstacles.barrels.find(b => b.x === x && b.y === y) || null; }
  isMud(x, y) { return this.obstacles.mud.some(m => m.x === x && m.y === y); }
  isBreakable(x, y) { return (this.obstacles.breakable || []).find(b => b.x === x && b.y === y) || null; }
  isHeal(x, y) { return (this.obstacles.heal || []).some(h => h.x === x && h.y === y); }
  isTeleport(x, y) { return (this.obstacles.teleport || []).some(t => t.x === x && t.y === y); }
  isBush(x, y) { return (this.obstacles.bush || []).some(b => b.x === x && b.y === y); }
  isBlocked(x, y) { return this.isWall(x, y) || !!this.isBarrel(x, y) || !!this.isBreakable(x, y); }

  // ---- Prise en charge des joueurs de plus d'une case (le Boss occupe une zone 2x2) ----
  // p.x,p.y désigne toujours le coin haut-gauche de son empreinte.
  playerCells(p) {
    const s = p.size || 1;
    if (s <= 1) return [{ x: p.x, y: p.y }];
    const cells = [];
    for (let dx = 0; dx < s; dx++) for (let dy = 0; dy < s; dy++) cells.push({ x: p.x + dx, y: p.y + dy });
    return cells;
  }
  playerOccupiesCell(p, x, y) {
    const s = p.size || 1;
    return x >= p.x && x < p.x + s && y >= p.y && y < p.y + s;
  }
  anyPlayerAt(x, y, excludeId) {
    for (const p of Object.values(this.players)) {
      if (!p.alive || p.id === excludeId) continue;
      if (this.playerOccupiesCell(p, x, y)) return p;
    }
    return null;
  }
  inBounds(x, y) { return inBoundsGlobal(x, y, this.gridSize); }

  // Cases centrales du mode Roi de la case, calculées selon la taille de grille active.
  // En Zone mobile, une seule case suit plutôt la position mouvante this.movingHillPos.
  hillCells() {
    const s = this.gridSize;
    const mid = Math.floor((s - 1) / 2);
    if (this.mode === "zoneMobile") {
      const pos = this.movingHillPos || { x: mid, y: mid };
      return [[pos.x, pos.y]];
    }
    if (s % 2 === 0) return [[mid, mid], [mid, mid + 1], [mid + 1, mid], [mid + 1, mid + 1]];
    return [[mid, mid]];
  }
  onHill(x, y) { return this.hillCells().some(([hx, hy]) => hx === x && hy === y); }

  // ---- Zone qui rétrécit (façon battle royale) ----
  shrinkCenter() { return { x: (this.gridSize - 1) / 2, y: (this.gridSize - 1) / 2 }; }
  isVoid(x, y) {
    if (!this.shrinkEnabled) return false;
    const c = this.shrinkCenter();
    const dist = Math.max(Math.abs(x - c.x), Math.abs(y - c.y));
    return dist > this.shrinkRadius;
  }

  generateMap(mapId, excludeCells) {
    const def = MAPS[mapId] || MAPS.open;
    const used = new Set((excludeCells || []).map(c => `${c.x},${c.y}`));
    const pick = () => {
      for (let tries = 0; tries < 300; tries++) {
        const x = randInt(this.gridSize), y = randInt(this.gridSize);
        const key = `${x},${y}`;
        if (!used.has(key)) { used.add(key); return { x, y }; }
      }
      return null;
    };
    const walls = [], barrels = [], mud = [], heal = [], teleport = [], breakable = [], lightningRod = [], bush = [];
    for (let i = 0; i < def.walls; i++) { const c = pick(); if (c) walls.push(c); }
    for (let i = 0; i < def.barrels; i++) { const c = pick(); if (c) barrels.push({ ...c, id: crypto.randomUUID() }); }
    for (let i = 0; i < def.mud; i++) { const c = pick(); if (c) mud.push(c); }
    for (let i = 0; i < (def.heal || 0); i++) { const c = pick(); if (c) heal.push(c); }
    for (let i = 0; i < (def.teleport || 0); i++) { const c = pick(); if (c) teleport.push(c); }
    for (let i = 0; i < (def.breakable || 0); i++) { const c = pick(); if (c) breakable.push({ ...c, hp: BREAKABLE_WALL_HP }); }
    for (let i = 0; i < (def.lightningRod || 0); i++) { const c = pick(); if (c) lightningRod.push(c); }
    for (let i = 0; i < (def.bush || 0); i++) { const c = pick(); if (c) bush.push(c); }
    this.obstacles = { walls, barrels, mud, heal, teleport, breakable, lightningRod, bush };
    this.mapId = MAPS[mapId] ? mapId : "open";
  }

  // Carte conçue par l'hôte (enregistrée en local côté client, envoyée au lancement).
  // Sécurité : au moins 12 cases praticables (murs+tonneaux exclus), sinon repli sur "open".
  useCustomMap(customMap, excludeCells) {
    customMap = customMap || {};
    const excludeSet = new Set((excludeCells || []).map(c => `${c.x},${c.y}`));
    const used = new Set();
    const cleanList = (arr) => (Array.isArray(arr) ? arr : [])
      .filter(c => c && Number.isInteger(c.x) && Number.isInteger(c.y) && this.inBounds(c.x, c.y) && !excludeSet.has(`${c.x},${c.y}`))
      .slice(0, 130)
      .filter(c => { const k = `${c.x},${c.y}`; if (used.has(k)) return false; used.add(k); return true; });

    const walls = cleanList(customMap.walls);
    const barrels = cleanList(customMap.barrels).map(c => ({ x: c.x, y: c.y, id: crypto.randomUUID() }));
    const mud = cleanList(customMap.mud);
    const heal = cleanList(customMap.heal);
    const teleport = cleanList(customMap.teleport);
    const breakable = cleanList(customMap.breakable).map(c => ({ x: c.x, y: c.y, hp: BREAKABLE_WALL_HP }));
    const lightningRod = cleanList(customMap.lightningRod);
    const bush = cleanList(customMap.bush);
    const freeWalkable = this.gridSize * this.gridSize - walls.length - barrels.length - breakable.length;
    if (freeWalkable < 12) { this.generateMap("open", excludeCells); return; }
    this.obstacles = { walls, barrels, mud, heal, teleport, breakable, lightningRod, bush };
    this.mapId = "custom";
  }

  freeSpawn(size) {
    size = size || 1;
    const fits = (x, y) => {
      for (let dx = 0; dx < size; dx++) for (let dy = 0; dy < size; dy++) {
        const cx = x + dx, cy = y + dy;
        if (!this.inBounds(cx, cy) || this.isBlocked(cx, cy) || this.anyPlayerAt(cx, cy, null)) return false;
      }
      return true;
    };
    for (let tries = 0; tries < 200; tries++) {
      const x = randInt(this.gridSize - size + 1), y = randInt(this.gridSize - size + 1);
      if (fits(x, y) && !this.isVoid(x, y)) return { x, y };
    }
    for (let tries = 0; tries < 200; tries++) {
      const x = randInt(this.gridSize - size + 1), y = randInt(this.gridSize - size + 1);
      if (fits(x, y)) return { x, y };
    }
    return { x: randInt(this.gridSize - size + 1), y: randInt(this.gridSize - size + 1) };
  }

  // ---- Joueurs / reconnexion ----
  // Choisit un nouvel hôte parmi les VRAIS joueurs seulement (jamais un bot) quand
  // l'hôte quitte. S'il ne reste plus aucun joueur réel, la partie s'arrête et tous
  // les bots disparaissent : les bots ne comptent jamais comme membres du salon.
  reassignHostOrClose(leavingId) {
    if (this.hostId !== leavingId) return;
    const successor = Object.values(this.players).find(p => !p.isBot);
    if (successor) { this.hostId = successor.id; return; }
    this.hostId = null;
    for (const id of Object.keys(this.players)) {
      if (this.players[id].isBot) delete this.players[id];
    }
    if (this.status === "playing") this.abortToLobby();
  }

  // Évite les doublons de pseudo dans une même partie : pseudo, puis pseudo_1, pseudo_2...
  uniquePseudo(base, excludeId) {
    const taken = Object.values(this.players).filter(p => p.id !== excludeId).map(p => p.pseudo);
    if (!taken.includes(base)) return base;
    let n = 1;
    while (taken.includes(`${base}_${n}`)) n++;
    return `${base}_${n}`;
  }

  addPlayer(ws, pseudo, clientId, opts) {
    opts = opts || {};
    const avatarEmoji = opts.avatarEmoji ? String(opts.avatarEmoji).slice(0, 4) : null;
    if (clientId) {
      const existing = Object.values(this.players).find(p => p.clientId === clientId);
      if (existing) {
        existing.ws = ws;
        existing.connected = true;
        existing.disconnectedAt = null;
        if (pseudo) existing.pseudo = this.uniquePseudo(pseudo, existing.id);
        if (avatarEmoji) existing.avatarEmoji = avatarEmoji;
        return existing;
      }
    }
    if (Object.keys(this.players).length >= this.maxPlayers) {
      const fillBot = Object.values(this.players).find(p => p.isFillBot);
      if (fillBot) delete this.players[fillBot.id];
      else return null;
    }
    if (Object.keys(this.players).length >= this.maxPlayers) return null;
    const id = crypto.randomUUID();
    const usedColors = Object.values(this.players).map(p => p.color);
    let color = null;
    if (opts.color && COLORS.includes(opts.color) && !usedColors.includes(opts.color)) color = opts.color;
    if (!color) color = COLORS.find(c => !usedColors.includes(c)) || COLORS[randInt(COLORS.length)];
    const spawn = this.freeSpawn();
    const player = {
      id, clientId: clientId || crypto.randomUUID(), pseudo: this.uniquePseudo(pseudo, null), color, avatarEmoji, x: spawn.x, y: spawn.y,
      hp: this.startingHP, alive: true, lastMove: 0, shield: false, respawnAt: null,
      eliminations: 0, score: 0, resistUntil: null, speedUntil: null, rootedUntil: null, slowedUntil: null, invulnUntil: null, forcedNextAttackId: null,
      damageDealt: 0, damageTaken: 0, timesKO: 0, team: null, biggestHit: 0, firstKillAt: null, lastTeleportAt: null, hidden: false, size: 1,
      connected: true, disconnectedAt: null, ws,
    };
    this.players[id] = player;
    if (!this.hostId) this.hostId = id;
    return player;
  }

  // Crée un joueur "bot" contrôlé par le serveur (utilisé pour le mode Boss).
  addBotPlayer(pseudo, difficulty) {
    const id = crypto.randomUUID();
    const usedColors = Object.values(this.players).map(p => p.color);
    const color = COLORS.find(c => !usedColors.includes(c)) || COLORS[randInt(COLORS.length)];
    const spawn = this.freeSpawn();
    const bot = {
      id, clientId: "bot-" + id, pseudo: this.uniquePseudo(pseudo || "Bot", null), color, avatarEmoji: "🤖",
      x: spawn.x, y: spawn.y,
      hp: this.startingHP, alive: true, lastMove: 0, shield: false, respawnAt: null,
      eliminations: 0, score: 0, resistUntil: null, speedUntil: null, rootedUntil: null, slowedUntil: null, invulnUntil: null, forcedNextAttackId: null,
      damageDealt: 0, damageTaken: 0, timesKO: 0, team: null, biggestHit: 0, firstKillAt: null, lastTeleportAt: null, hidden: false, size: 1,
      connected: true, disconnectedAt: null, ws: null, isBot: true,
      botDifficulty: BOT_DIFFICULTIES.includes(difficulty) ? difficulty : "medium",
    };
    this.players[id] = bot;
    return bot;
  }

  // Complète (ou retire) des bots de remplissage pour atteindre maxPlayers dans le
  // salon d'attente — jamais pendant une partie en cours. Les vrais joueurs priment
  // toujours : un bot de remplissage est retiré dès qu'un joueur en a besoin.
  syncBotFill() {
    if (this.status !== "lobby") return;
    let fillBotIds = Object.values(this.players).filter(p => p.isFillBot).map(p => p.id);
    const realCount = Object.keys(this.players).length - fillBotIds.length;
    if (realCount === 0) {
      // une salle ne contient jamais que des bots : sans vrai joueur, aucun bot.
      for (const id of fillBotIds) delete this.players[id];
      return;
    }
    const target = Math.max(0, Math.min(this.fillBotCount || 0, this.maxPlayers - realCount));
    while (fillBotIds.length > target) {
      const id = fillBotIds.pop();
      delete this.players[id];
    }
    while (fillBotIds.length < target) {
      const usedNames = Object.values(this.players).map(p => p.pseudo);
      const available = shuffle(BOT_NAMES.filter(n => !usedNames.includes(n)));
      const name = available[0] || `Bot ${fillBotIds.length + 1}`;
      const bot = this.addBotPlayer(name, this.fillBotDifficulty);
      bot.isFillBot = true;
      fillBotIds.push(bot.id);
    }
  }

  // Retire tout bot résiduel d'une précédente partie en mode Boss — jamais les
  // bots de remplissage, qui doivent survivre au passage salon -> partie.
  removeAllBots() {
    for (const id of Object.keys(this.players)) {
      if (this.players[id].isBot && !this.players[id].isFillBot) delete this.players[id];
    }
  }

  handleDisconnect(id) {
    const p = this.players[id];
    if (!p) return;
    if (this.status === "playing") {
      p.connected = false; p.ws = null; p.disconnectedAt = Date.now();
      this.pushLog(`${p.pseudo} est déconnecté — reconnexion possible.`);
    } else {
      this.pushLog(`${p.pseudo} a quitté la partie.`);
      delete this.players[id];
      this.reassignHostOrClose(id);
      this.syncBotFill();
    }
  }

  removePlayerFully(id) {
    const p = this.players[id];
    if (!p) return;
    this.pushLog(`${p.pseudo} a quitté la partie.`);
    delete this.players[id];
    this.reassignHostOrClose(id);
    if (this.status === "playing") this.checkWinCondition();
    this.syncBotFill();
  }

  // Exclusion par l'hôte : notifie le joueur visé puis le retire définitivement.
  kickPlayer(targetId) {
    const p = this.players[targetId];
    if (!p) return;
    if (p.ws && p.ws.readyState === 1) {
      try { p.ws.send(JSON.stringify({ type: "kicked" })); } catch (e) { /* ignore */ }
      try { p.ws.close(1000, "kicked"); } catch (e) { /* ignore */ }
    }
    this.pushLog(`${p.pseudo} a été exclu par l'hôte.`);
    delete this.players[targetId];
    this.reassignHostOrClose(targetId);
    if (this.status === "playing") this.checkWinCondition();
    this.syncBotFill();
    this.broadcastState();
  }

  // Transfert de la propriété du salon à un autre joueur connecté.
  transferHost(targetId) {
    const p = this.players[targetId];
    if (!p || !p.connected) return;
    this.hostId = targetId;
    this.pushLog(`${p.pseudo} est désormais l'hôte.`);
    this.broadcastState();
  }

  purgeStaleDisconnected() {
    for (const [id, p] of Object.entries(this.players)) {
      if (!p.connected && p.disconnectedAt && Date.now() - p.disconnectedAt > RECONNECT_GRACE_MS) {
        this.pushLog(`${p.pseudo} a été retiré — déconnecté trop longtemps.`);
        delete this.players[id];
        this.reassignHostOrClose(id);
      }
    }
  }

  abortToLobby() {
    if (this.status === "lobby") return;
    this.status = "lobby";
    this.removeAllBots();
    this.turn = null;
    this.winner = null;
    this.hazards = [];
    this.powerups = [];
    this.treasures = [];
    this.suddenDeath = false;
    this.suddenDeathIds = new Set();
    if (this.timer) clearTimeout(this.timer);
    if (this.hillTimer) clearInterval(this.hillTimer);
    if (this.secondTimer) clearInterval(this.secondTimer);
    this.pendingAttacks.forEach(h => clearTimeout(h));
    this.pendingAttacks.clear();
    this.activeTelegraphs = [];
    this.pushLog("L'hôte a terminé la partie. Retour au salon.");
    this.broadcastState();
  }

  // ---- Démarrage / relance ----
  start(mode, rawConfig) {
    if (this.status === "playing") return;
    for (const [id, p] of Object.entries(this.players)) {
      if (!p.connected) { delete this.players[id]; this.reassignHostOrClose(id); }
    }
    if (Object.keys(this.players).length < 1) return;
    if (!MODES[mode]) mode = "koHunt";
    rawConfig = rawConfig || {};
    this.removeAllBots(); // repart toujours d'un état propre : un éventuel bot d'une précédente partie Boss disparaît

    const config = {};
    if (mode === "koHunt") config.targetKO = clamp(parseInt(rawConfig.targetKO) || 5, 1, 50);
    if (mode === "kingHill" || mode === "zoneMobile") config.targetScore = clamp(parseInt(rawConfig.targetScore) || 20, 1, 200);
    if (mode === "chrono") config.minutes = clamp(parseFloat(rawConfig.minutes) || 5, 1, 60);
    if (mode === "ctf") config.targetCaptures = clamp(parseInt(rawConfig.targetCaptures) || 3, 1, 20);
    if (mode === "treasureHunt") config.targetTreasures = clamp(parseInt(rawConfig.targetTreasures) || 8, 1, 50);
    if (mode === "escort") config.escortMinutes = clamp(parseFloat(rawConfig.escortMinutes) || 3, 1, 15);
    if (mode === "infection") config.infectionMinutes = clamp(parseFloat(rawConfig.infectionMinutes) || 4, 1, 30);

    this.mode = mode;
    this.config = config;
    this.gridSize = DEFAULT_GRID_SIZE; // taille fixe, plus configurable par l'hôte
    this.winner = null;
    this.hazards = [];
    this.powerups = [];
    this.lastPowerupSpawn = Date.now();
    this.treasures = [];
    this.lastTreasureSpawn = Date.now();
    this.powerupsEnabled = rawConfig.powerupsEnabled !== false && rawConfig.powerupsEnabled !== "false";
    this.powerupIntervalSec = clamp(parseInt(rawConfig.powerupIntervalSec) || DEFAULT_POWERUP_INTERVAL_SEC, 5, 120);
    this.teamsEnabled = rawConfig.teamsEnabled === true || rawConfig.teamsEnabled === "true";
    this.pushEnabled = rawConfig.pushEnabled !== false && rawConfig.pushEnabled !== "false";
    this.shrinkEnabled = rawConfig.shrinkEnabled === true || rawConfig.shrinkEnabled === "true";
    this.shrinkMode = SHRINK_MODES.includes(rawConfig.shrinkMode) ? rawConfig.shrinkMode : "medium";
    this.shrinkIntervalSec = this.shrinkMode === "custom"
      ? clamp(parseInt(rawConfig.shrinkIntervalSec) || 18, 3, 300)
      : (SHRINK_PRESETS_SEC[this.shrinkMode] || SHRINK_PRESETS_SEC.medium);
    this.shrinkRadius = SHRINK_INITIAL_RADIUS;
    this.lastShrinkAt = Date.now();

    // ---- Paramètres avancés ----
    this.startingHP = clamp(Math.round(numOr(rawConfig.startingHP, DEFAULT_START_HP)), 30, 300);
    this.respawnDelaySec = clamp(numOr(rawConfig.respawnDelaySec, DEFAULT_RESPAWN_DELAY_SEC), 1, 20);
    this.respawnHpPercent = clamp(Math.round(numOr(rawConfig.respawnHpPercent, DEFAULT_RESPAWN_HP_PERCENT)), 5, 100);
    this.attackWindowSec = clamp(numOr(rawConfig.attackWindowSec, DEFAULT_ATTACK_WINDOW_SEC), 4, 60);
    this.turnGapSec = clamp(numOr(rawConfig.turnGapSec, DEFAULT_TURN_GAP_SEC), 0.5, 15);
    this.moveCooldownMs = clamp(Math.round(numOr(rawConfig.moveCooldownMs, DEFAULT_MOVE_COOLDOWN_MS)), 150, 3000);
    this.damageMultiplier = clamp(numOr(rawConfig.damageMultiplier, DEFAULT_DAMAGE_MULTIPLIER), 0.25, 3);
    this.barrelDamage = clamp(Math.round(numOr(rawConfig.barrelDamage, DEFAULT_BARREL_DAMAGE)), 0, 100);
    this.powerupMaxOnMap = clamp(Math.round(numOr(rawConfig.powerupMaxOnMap, DEFAULT_POWERUP_MAX_ON_MAP)), 0, 8);
    this.weaponNoRepeat = rawConfig.weaponNoRepeat !== false && rawConfig.weaponNoRepeat !== "false";
    this.hideAttackFromOthers = rawConfig.hideAttackFromOthers !== false && rawConfig.hideAttackFromOthers !== "false";
    this.twoWeaponHand = rawConfig.twoWeaponHand === true || rawConfig.twoWeaponHand === "true";
    this.mineVisibleToAll = rawConfig.mineVisibleToAll === true || rawConfig.mineVisibleToAll === "true";

    this.attackWeightOverrides = {};
    if (rawConfig.attackWeights && typeof rawConfig.attackWeights === "object") {
      for (const a of ATTACKS) {
        const raw = rawConfig.attackWeights[a.id];
        if (raw !== undefined && raw !== "") this.attackWeightOverrides[a.id] = clamp(numOr(raw, 100) / 100, 0, 5);
      }
    }
    const fieldOverrides = (rawConfig.attackOverrides && typeof rawConfig.attackOverrides === "object") ? rawConfig.attackOverrides : {};
    this.attacksRuntime = ATTACKS.map(a => {
      const ov = fieldOverrides[a.id];
      if (!ov || typeof ov !== "object") return a;
      const merged = { ...a };
      for (const [field, range] of Object.entries(TUNABLE_FIELD_RANGES)) {
        if (a[field] === undefined || ov[field] === undefined || ov[field] === "") continue;
        merged[field] = clamp(numOr(ov[field], a[field]), range[0], range[1]);
      }
      return merged;
    });
    this.telegraphMultiplier = clamp(numOr(rawConfig.telegraphMultiplier, 1), 0.4, 3);
    this.buffDurationSec = clamp(numOr(rawConfig.buffDurationSec, BUFF_DURATION_SEC_DEFAULT), 3, 30);
    this.mudSlowMultiplier = clamp(numOr(rawConfig.mudSlowMultiplier, MUD_COOLDOWN_MULT_DEFAULT), 1, 5);
    this.spawnProtectionSec = clamp(numOr(rawConfig.spawnProtectionSec, 0), 0, 8);
    this.passiveRegenPerSec = clamp(numOr(rawConfig.passiveRegenPerSec, 0), 0, 10);

    this.suddenDeath = false;
    this.suddenDeathIds = new Set();
    this.lastAttackId = null;
    this.turnQueue = [];
    this.turn = null;
    this.pendingAttacks.forEach(h => clearTimeout(h));
    this.pendingAttacks.clear();
    this.activeTelegraphs = [];

    this.movingHillPos = null;
    if (mode === "zoneMobile") {
      const mid = Math.floor((this.gridSize - 1) / 2);
      this.movingHillPos = { x: mid, y: mid };
      this.lastHillMoveAt = Date.now();
    }
    const hillExclude = (mode === "kingHill" || mode === "zoneMobile") ? this.hillCells().map(([x, y]) => ({ x, y })) : [];
    if (rawConfig.mapId === "custom" && rawConfig.customMap) this.useCustomMap(rawConfig.customMap, hillExclude);
    else this.generateMap(rawConfig.mapId, hillExclude);

    this.bossId = null;
    if (mode === "boss") {
      this.bossHpMultiplier = clamp(numOr(rawConfig.bossHpMultiplier, 3), 1.5, 6);
      this.teamsEnabled = false; // le mode Boss n'a pas de sens avec des équipes
      if (rawConfig.bossIsBot === true || rawConfig.bossIsBot === "true") {
        const bot = this.addBotPlayer(rawConfig.bossPseudo || "Boss Bot");
        this.bossId = bot.id;
      } else {
        const ids = Object.keys(this.players);
        const wanted = rawConfig.bossPlayerId;
        this.bossId = (wanted && wanted !== "random" && this.players[wanted]) ? wanted : ids[randInt(ids.length)];
      }
    }

    this.flags = [];
    if (mode === "ctf") {
      this.teamsEnabled = true; // la capture du drapeau exige deux équipes
      const bx = 1, by = 1, bx2 = this.gridSize - 2, by2 = this.gridSize - 2;
      const clearBase = (x, y) => {
        this.obstacles.walls = this.obstacles.walls.filter(w => !(w.x === x && w.y === y));
        this.obstacles.barrels = this.obstacles.barrels.filter(b => !(b.x === x && b.y === y));
      };
      clearBase(bx, by); clearBase(bx2, by2);
      this.flags = [
        { team: "A", baseX: bx, baseY: by, x: bx, y: by, carrierId: null },
        { team: "B", baseX: bx2, baseY: by2, x: bx2, y: by2, carrierId: null },
      ];
    }

    this.escortId = null;
    if (mode === "escort") {
      this.teamsEnabled = false; // le VIP à protéger n'a pas de sens avec des équipes
      const ids = Object.keys(this.players);
      this.escortId = ids[randInt(ids.length)];
    }

    this.infectionEndAt = null;
    if (mode === "infection") {
      this.teamsEnabled = false; // infectés vs humains, pas d'équipes séparées en plus
    }

    const playerList = Object.values(this.players);
    playerList.forEach((p, idx) => {
      const isBoss = mode === "boss" && p.id === this.bossId;
      p.size = isBoss ? 2 : 1;
      const spawn = this.freeSpawn(p.size);
      p.hp = isBoss ? Math.round(this.startingHP * this.bossHpMultiplier) : this.startingHP;
      p.alive = true; p.x = spawn.x; p.y = spawn.y;
      p.shield = false; p.respawnAt = null; p.resistUntil = null; p.speedUntil = null;
      p.infected = false;
      p.rootedUntil = null; p.slowedUntil = null;
      p.invulnUntil = this.spawnProtectionSec > 0 ? Date.now() + this.spawnProtectionSec * 1000 : null;
      p.eliminations = 0; p.score = 0; p.damageDealt = 0; p.damageTaken = 0; p.timesKO = 0; p.biggestHit = 0; p.firstKillAt = null; p.lastTeleportAt = null; p.hidden = false;
      p.team = this.teamsEnabled ? (idx % 2 === 0 ? "A" : "B") : null;
    });

    if (mode === "infection") {
      const ids = Object.keys(this.players);
      const patientZero = ids[randInt(ids.length)];
      this.players[patientZero].infected = true;
      this.infectionEndAt = Date.now() + config.infectionMinutes * 60000;
    }

    this.status = "playing";
    this.matchStartedAt = Date.now();
    if (mode === "chrono") this.chronoEndAt = Date.now() + config.minutes * 60000;
    else this.chronoEndAt = null;

    this.mapModifiers = Array.isArray(rawConfig.mapModifiers) ? rawConfig.mapModifiers.filter(m => MAP_MODIFIERS[m]) : [];
    this.modifierSettings = defaultModifierSettings();
    const modOverrides = (rawConfig.modifierOverrides && typeof rawConfig.modifierOverrides === "object") ? rawConfig.modifierOverrides : {};
    for (const [id, fields] of Object.entries(MODIFIER_TUNABLE_RANGES)) {
      const submitted = modOverrides[id] || {};
      for (const [field, [min, max]] of Object.entries(fields)) {
        const val = numOr(submitted[field], this.modifierSettings[id][field]);
        this.modifierSettings[id][field] = clamp(val, min, max);
      }
    }
    this.modifierNextAt = {};
    this.zombies = [];
    for (const m of this.mapModifiers) {
      const [lo, hi] = modifierIntervalSec(this, m);
      this.modifierNextAt[m] = this.matchStartedAt + (lo + Math.random() * (hi - lo)) * 1000;
    }

    this.pushLog(`Partie lancée — mode ${MODES[mode].label} sur ${MAPS[this.mapId].label}${this.teamsEnabled ? " — par équipes" : ""} !`);
    this.broadcastState();

    if (this.hillTimer) clearInterval(this.hillTimer);
    if (mode === "kingHill" || mode === "zoneMobile") {
      this.hillTimer = setInterval(() => this.hillTick(), HILL_TICK_MS);
      this.hillTimer.unref();
    }

    if (this.secondTimer) clearInterval(this.secondTimer);
    this.secondTimer = setInterval(() => this.secondTick(), 1000);
    this.secondTimer.unref();

    // Le mode Infection n'a pas d'armes ni de tours : c'est une pure chasse au
    // déplacement, on ne lance donc jamais le cycle de tirage d'attaques.
    if (mode !== "infection") this.scheduleTick(this.turnGapSec * 1000);
  }

  scheduleTick(delayMs) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delayMs);
    this.timer.unref();
  }

  endGame(winnerIds, reason) {
    if (this.status !== "playing") return;
    this.status = "ended";
    this.winner = { ids: winnerIds, reason };
    if (this.timer) clearTimeout(this.timer);
    if (this.hillTimer) clearInterval(this.hillTimer);
    if (this.secondTimer) clearInterval(this.secondTimer);
    this.pendingAttacks.forEach(h => clearTimeout(h));
    this.pendingAttacks.clear();
    this.activeTelegraphs = [];
    this.turn = null;
    const names = winnerIds.map(id => this.players[id]?.pseudo).filter(Boolean);
    this.pushLog(names.length ? `Victoire de ${names.join(" et ")} !` : "Match nul — personne ne l'emporte.");
    this.broadcastState();
  }

  checkWinCondition() {
    if (this.status !== "playing") return;
    if (this.teamsEnabled) { this.checkTeamWinCondition(); return; }
    const list = Object.values(this.players);

    if (this.mode === "survivor") {
      if (list.length > 1) {
        const alive = list.filter(p => p.alive);
        if (alive.length <= 1) { this.endGame(alive.map(p => p.id), "survivor"); return; }
      }
    } else if (this.mode === "koHunt") {
      const winner = list.find(p => p.eliminations >= this.config.targetKO);
      if (winner) { this.endGame([winner.id], "koHunt"); return; }
    } else if (this.mode === "kingHill" || this.mode === "zoneMobile") {
      const winner = list.find(p => p.score >= this.config.targetScore);
      if (winner) { this.endGame([winner.id], this.mode); return; }
    } else if (this.mode === "treasureHunt") {
      const winner = list.find(p => p.score >= this.config.targetTreasures);
      if (winner) { this.endGame([winner.id], "treasureHunt"); return; }
    } else if (this.mode === "escort") {
      const vip = this.players[this.escortId];
      if (!vip || !vip.alive) {
        const winners = list.filter(p => p.id !== this.escortId).map(p => p.id);
        this.endGame(winners, "escort");
        return;
      }
    } else if (this.mode === "infection") {
      if (list.length > 1 && list.every(p => p.infected)) { this.endGame(list.map(p => p.id), "infection"); return; }
    } else if (this.mode === "boss") {
      const boss = this.players[this.bossId];
      if (!boss || !boss.alive) {
        const winners = list.filter(p => p.id !== this.bossId && p.alive).map(p => p.id);
        this.endGame(winners, "boss");
        return;
      }
      const huntersAlive = list.filter(p => p.id !== this.bossId && p.alive);
      if (list.length > 1 && huntersAlive.length === 0) { this.endGame([this.bossId], "boss"); return; }
    }
  }

  checkTeamWinCondition() {
    const list = Object.values(this.players);
    const teamsPresent = [...new Set(list.map(p => p.team).filter(Boolean))];

    if (this.mode === "survivor") {
      if (list.length > 1) {
        const aliveTeams = new Set(list.filter(p => p.alive).map(p => p.team));
        if (aliveTeams.size <= 1) { this.endGame(list.filter(p => aliveTeams.has(p.team)).map(p => p.id), "survivor"); return; }
      }
    } else if (this.mode === "koHunt") {
      for (const t of teamsPresent) {
        const sum = list.filter(p => p.team === t).reduce((s, p) => s + p.eliminations, 0);
        if (sum >= this.config.targetKO) { this.endGame(list.filter(p => p.team === t).map(p => p.id), "koHunt"); return; }
      }
    } else if (this.mode === "kingHill" || this.mode === "zoneMobile") {
      for (const t of teamsPresent) {
        const sum = list.filter(p => p.team === t).reduce((s, p) => s + p.score, 0);
        if (sum >= this.config.targetScore) { this.endGame(list.filter(p => p.team === t).map(p => p.id), this.mode); return; }
      }
    } else if (this.mode === "treasureHunt") {
      for (const t of teamsPresent) {
        const sum = list.filter(p => p.team === t).reduce((s, p) => s + p.score, 0);
        if (sum >= this.config.targetTreasures) { this.endGame(list.filter(p => p.team === t).map(p => p.id), "treasureHunt"); return; }
      }
    } else if (this.mode === "ctf") {
      for (const t of teamsPresent) {
        const captures = list.filter(p => p.team === t).reduce((s, p) => s + p.score, 0);
        if (captures >= this.config.targetCaptures) { this.endGame(list.filter(p => p.team === t).map(p => p.id), "ctf"); return; }
      }
    }
  }

  // ---- Dégâts / éliminations ----
  applyDamage(attackerId, player, amount) {
    if (!player.alive) return;
    if (player.invulnUntil && Date.now() < player.invulnUntil) return; // protégé après son (re)spawn
    if (this.teamsEnabled && attackerId) {
      const attacker = this.players[attackerId];
      if (attacker && attacker.team && attacker.team === player.team && attacker.id !== player.id) return;
    }
    if (player.shield) { player.shield = false; this.pushLog(`${player.pseudo} bloque l'attaque avec son bouclier !`); return; }
    amount = amount * this.damageMultiplier;
    if (player.resistUntil && Date.now() < player.resistUntil) amount = amount * RESIST_DAMAGE_MULT;
    amount = Math.max(0, Math.round(amount));
    player.hp = clamp(player.hp - amount, 0, this.startingHP);
    player.damageTaken += amount;
    if (attackerId) {
      const attacker = this.players[attackerId];
      if (attacker && attacker.id !== player.id) {
        attacker.damageDealt += amount;
        if (amount > attacker.biggestHit) attacker.biggestHit = amount;
      }
    }
    if (player.hp === 0) this.onElimination(attackerId, player);
  }
  applyHeal(player, amount) { if (player.alive) player.hp = clamp(player.hp + amount, 0, this.startingHP); }

  onElimination(attackerId, victim) {
    victim.alive = false;
    victim.timesKO += 1;
    this.pushLog(`${victim.pseudo} est K.O. !`);

    if (attackerId && attackerId !== victim.id) {
      const attacker = this.players[attackerId];
      if (attacker && !attacker.firstKillAt) attacker.firstKillAt = Date.now();
    }

    if (this.mode === "ctf") {
      const dropped = this.flags.find(f => f.carrierId === victim.id);
      if (dropped) { dropped.carrierId = null; this.pushLog("Le drapeau tombe au sol !"); }
    }

    if (this.shrinkEnabled && this.shrinkMode === "onKO" && this.shrinkRadius > SHRINK_MIN_RADIUS) {
      this.shrinkRadius -= 1;
      this.lastShrinkAt = Date.now();
      this.pushLog("⚠️ La zone se rétrécit !");
    }

    const attacker = attackerId ? this.players[attackerId] : null;
    if (attacker && attacker.id !== victim.id) attacker.eliminations += 1;

    if (this.suddenDeath && attacker && this.suddenDeathIds.has(attacker.id)) {
      const winners = this.teamsEnabled && attacker.team
        ? Object.values(this.players).filter(p => p.team === attacker.team).map(p => p.id)
        : [attacker.id];
      this.endGame(winners, "suddenDeath");
      return;
    }

    const respawns = MODES[this.mode] ? MODES[this.mode].respawns : true;
    victim.respawnAt = respawns ? Date.now() + this.respawnDelaySec * 1000 : null;

    this.checkWinCondition();
  }

  // Joueur vivant le plus proche d'une case, en excluant certains ids (chaîne d'éclairs).
  nearestAliveExcluding(x, y, excludeIds) {
    let best = null, bestDist = Infinity;
    for (const p of Object.values(this.players)) {
      if (!p.alive || excludeIds.has(p.id)) continue;
      const d = Math.abs(p.x - x) + Math.abs(p.y - y);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    return best;
  }

  // Cible d'un bot : jamais un coéquipier. Pour les attaques en ligne (direction),
  // privilégie un ennemi déjà parfaitement aligné (même ligne/colonne) pour ne pas
  // tirer dans le vide, sinon se rabat sur le plus proche.
  botPickTarget(bot, preferAligned) {
    const enemies = Object.values(this.players).filter(p =>
      p.alive && p.id !== bot.id && !(this.teamsEnabled && bot.team && p.team === bot.team));
    if (!enemies.length) return null;
    const pool = preferAligned ? enemies.filter(p => p.x === bot.x || p.y === bot.y) : enemies;
    const from = pool.length ? pool : enemies;
    let best = null, bestDist = Infinity;
    for (const p of from) {
      const d = Math.abs(p.x - bot.x) + Math.abs(p.y - bot.y);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    return best;
  }

  cellsForZone(anchorX, anchorY, size) {
    const half = Math.floor(size / 2);
    const cells = [];
    for (let dx = -half; dx <= size - 1 - half; dx++) {
      for (let dy = -half; dy <= size - 1 - half; dy++) {
        const x = anchorX + dx, y = anchorY + dy;
        if (this.inBounds(x, y)) cells.push({ x, y });
      }
    }
    return cells;
  }

  // ---- Bonus au sol ----
  applyPowerup(player, type) {
    if (type === "heal") { this.applyHeal(player, 30); this.pushLog(`${player.pseudo} récupère un bonus de vie !`); }
    else if (type === "resist") { player.resistUntil = Date.now() + this.buffDurationSec * 1000; this.pushLog(`${player.pseudo} récupère un bonus de résistance !`); }
    else if (type === "speed") { player.speedUntil = Date.now() + this.buffDurationSec * 1000; this.pushLog(`${player.pseudo} récupère un bonus de vitesse !`); }
  }

  checkPowerupPickup(player, x, y) {
    const idx = this.powerups.findIndex(pu => pu.x === x && pu.y === y);
    if (idx < 0) return;
    const pu = this.powerups[idx];
    this.powerups.splice(idx, 1);
    this.applyPowerup(player, pu.type);
  }

  // ---- Chasse au trésor ----
  checkTreasurePickup(player, x, y) {
    if (this.mode !== "treasureHunt") return;
    const idx = this.treasures.findIndex(t => t.x === x && t.y === y);
    if (idx < 0) return;
    this.treasures.splice(idx, 1);
    player.score += 1;
    this.pushLog(`${player.pseudo} ramasse un trésor ! (${player.score}/${this.config.targetTreasures})`);
    this.checkWinCondition();
  }

  // ---- Infection : contamine tout joueur sain à portée d'un joueur infecté ----
  checkInfectionTag(mover) {
    if (this.mode !== "infection" || !mover.alive) return;
    const nearby = Object.values(this.players).filter(p => p.id !== mover.id && p.alive &&
      Math.abs(p.x - mover.x) <= INFECTION_TAG_RADIUS && Math.abs(p.y - mover.y) <= INFECTION_TAG_RADIUS);
    let changed = false;
    if (mover.infected) {
      for (const p of nearby) {
        if (!p.infected) { p.infected = true; this.pushLog(`🧟 ${p.pseudo} a été infecté par ${mover.pseudo} !`); changed = true; }
      }
    } else {
      const infector = nearby.find(p => p.infected);
      if (infector) { mover.infected = true; this.pushLog(`🧟 ${mover.pseudo} a été infecté par ${infector.pseudo} !`); changed = true; }
    }
    if (changed) this.checkWinCondition();
  }

  // ---- Capture du drapeau ----
  checkFlagInteractions(player, x, y) {
    if (this.mode !== "ctf" || !player.team) return;
    const myCarriedFlag = this.flags.find(f => f.carrierId === player.id);
    if (myCarriedFlag) { myCarriedFlag.x = x; myCarriedFlag.y = y; }

    for (const flag of this.flags) {
      if (flag.x !== x || flag.y !== y) continue;
      if (flag.team === player.team) {
        if (flag.carrierId) continue; // ne devrait pas arriver : son propre drapeau n'est jamais "porté"
        if (flag.x !== flag.baseX || flag.y !== flag.baseY) {
          flag.x = flag.baseX; flag.y = flag.baseY;
          this.pushLog(`${player.pseudo} ramène son drapeau à la base !`);
          continue;
        }
        if (myCarriedFlag && myCarriedFlag.team !== player.team) {
          myCarriedFlag.carrierId = null;
          myCarriedFlag.x = myCarriedFlag.baseX; myCarriedFlag.y = myCarriedFlag.baseY;
          player.score += 1;
          this.pushLog(`🚩 ${player.pseudo} capture le drapeau !`);
          this.checkWinCondition();
        }
      } else if (!flag.carrierId) {
        flag.carrierId = player.id;
        this.pushLog(`${player.pseudo} s'empare du drapeau adverse !`);
      }
    }
  }

  checkMineTrigger(player, x, y) {
    const mineIdx = this.hazards.findIndex(h => h.type === "mine" && h.x === x && h.y === y);
    if (mineIdx < 0) return;
    const mine = this.hazards[mineIdx];
    this.hazards.splice(mineIdx, 1);
    this.applyDamage(mine.ownerId, player, mine.damage || 30);
    this.pushLog(`${player.pseudo} a déclenché un piège explosif !`);
  }

  // ---- Tonneaux : explosion en chaîne ----
  triggerBarrelChain(attackerId, startCells) {
    const hitPlayerAt = (x, y) => this.anyPlayerAt(x, y);

    // Murs cassables (carte Jardin) : encaissent des dégâts à chaque impact, peu importe l'attaque.
    for (const c of startCells) {
      const wall = this.isBreakable(c.x, c.y);
      if (!wall) continue;
      wall.hp -= BREAKABLE_WALL_DAMAGE_PER_HIT;
      if (wall.hp <= 0) {
        this.obstacles.breakable = this.obstacles.breakable.filter(w => w !== wall);
        this.pushLog("Un mur cède sous les coups !");
      }
    }

    // Ombres du cimetière : peuvent aussi être attaquées et tuées par les joueurs.
    if (this.zombies && this.zombies.length) {
      for (const c of startCells) {
        const z = this.zombies.find(zz => zz.x === c.x && zz.y === c.y);
        if (!z) continue;
        z.hp -= ZOMBIE_DAMAGE_PER_HIT;
        if (z.hp <= 0) {
          this.zombies = this.zombies.filter(zz => zz.id !== z.id);
          this.pushLog("🧟 Une ombre est détruite !");
        }
      }
    }

    const queue = startCells.slice();
    const extra = [];
    const exploded = new Set();
    let guard = 0;
    while (queue.length && guard < 200) {
      guard++;
      const c = queue.shift();
      const barrel = this.isBarrel(c.x, c.y);
      if (!barrel || exploded.has(barrel.id)) continue;
      exploded.add(barrel.id);
      this.obstacles.barrels = this.obstacles.barrels.filter(b => b.id !== barrel.id);
      this.pushLog("Un tonneau explose !");
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const bx = c.x + dx, by = c.y + dy;
        if (!this.inBounds(bx, by)) continue;
        extra.push({ x: bx, y: by });
        const bp = hitPlayerAt(bx, by);
        if (bp) this.applyDamage(attackerId, bp, this.barrelDamage);
        if (this.isBarrel(bx, by)) queue.push({ x: bx, y: by });
      }
    }
    return extra;
  }

  // ---- Déplacement (avec poussée des autres joueurs) ----
  handleMove(player, msg) {
    if (!player.alive) return;
    const now = Date.now();
    if (player.rootedUntil && now < player.rootedUntil) return;
    let cooldown = this.moveCooldownMs;
    if (this.isMud(player.x, player.y)) cooldown *= this.mudSlowMultiplier;
    if (player.slowedUntil && now < player.slowedUntil) cooldown *= this.mudSlowMultiplier;
    if (player.speedUntil && now < player.speedUntil) cooldown = Math.round(cooldown * SPEED_COOLDOWN_MULT);
    if (now - player.lastMove < cooldown) return;

    const { x, y } = msg;
    if (typeof x !== "number" || typeof y !== "number") return;
    const dx = x - player.x, dy = y - player.y;
    if (!((Math.abs(dx) === 1 && dy === 0) || (dx === 0 && Math.abs(dy) === 1))) return;

    // Empreinte complète à la nouvelle position (1 case, ou 2x2 pour le Boss).
    const size = player.size || 1;
    const newCells = [];
    for (let ddx = 0; ddx < size; ddx++) for (let ddy = 0; ddy < size; ddy++) newCells.push({ x: x + ddx, y: y + ddy });
    if (!newCells.every(c => this.inBounds(c.x, c.y))) return;
    if (newCells.some(c => this.isBlocked(c.x, c.y))) return;

    const occupant = newCells.map(c => this.anyPlayerAt(c.x, c.y, player.id)).find(Boolean);
    if (occupant) {
      if (!this.pushEnabled || (occupant.size || 1) > 1) return; // trop imposant (le Boss) pour être poussé
      const pushX = occupant.x + dx, pushY = occupant.y + dy;
      const pushBlocked = !this.inBounds(pushX, pushY) || this.isBlocked(pushX, pushY) ||
        !!this.anyPlayerAt(pushX, pushY, occupant.id);
      if (pushBlocked) return;
      occupant.x = pushX; occupant.y = pushY;
      this.pushLog(`${player.pseudo} pousse ${occupant.pseudo} !`);
      this.checkMineTrigger(occupant, pushX, pushY);
    }

    player.x = x; player.y = y; player.lastMove = now;
    this.checkMineTrigger(player, x, y);
    this.checkPowerupPickup(player, x, y);
    this.checkTreasurePickup(player, x, y);
    this.checkInfectionTag(player);
    this.checkFlagInteractions(player, x, y);
    this.checkTeleportTile(player, player.x, player.y);
    player.hidden = this.isBush(player.x, player.y);

    this.broadcastState();
  }

  // Carte Labo : marcher sur une case de téléportation envoie vers une autre case
  // de téléportation au hasard, avec un temps de recharge par joueur pour éviter le spam.
  checkTeleportTile(player, x, y) {
    if (!this.isTeleport(x, y)) return;
    const now = Date.now();
    if (player.lastTeleportAt && now - player.lastTeleportAt < TELEPORT_TILE_COOLDOWN_MS) return;
    const others = (this.obstacles.teleport || []).filter(t => !(t.x === x && t.y === y));
    if (!others.length) return;
    const dest = others[randInt(others.length)];
    const occupied = !!this.anyPlayerAt(dest.x, dest.y, player.id);
    if (occupied) return;
    player.x = dest.x; player.y = dest.y;
    player.lastTeleportAt = now;
    player.hidden = this.isBush(player.x, player.y);
    this.pushLog(`${player.pseudo} est téléporté !`);
  }

  // Codes secrets : "nuke" force la bombe nucléaire au prochain tour du joueur ;
  // "choose" force n'importe quelle autre attaque valide (jamais la bombe elle-même).
  // Main de 2 armes : le joueur actif peut choisir laquelle des deux armes
  // tirées au sort il veut utiliser, avant de viser.
  handleChooseWeapon(player, msg) {
    if (!this.turn || this.turn.playerId !== player.id || !this.turn.altAttack) return;
    if (msg.attackId === this.turn.altAttack.id) {
      const previous = this.turn.attack;
      this.turn.attack = this.turn.altAttack;
      this.turn.altAttack = previous;
      this.lastAttackId = this.turn.attack.id;
      this.broadcastState();
    }
    // Si msg.attackId correspond déjà à l'arme active, rien à faire.
  }

  handleCheatCode(player, msg) {
    if (msg.code === "nuke") {
      player.forcedNextAttackId = "nuke";
      this.pushLog(`${player.pseudo} a activé un code secret… 👀`);
    } else if (msg.code === "choose" && msg.attackId && msg.attackId !== "nuke") {
      const valid = this.attacksRuntime.find(a => a.id === msg.attackId && !a.secret);
      if (valid) {
        player.forcedNextAttackId = valid.id;
        this.pushLog(`${player.pseudo} a activé un code secret… 👀`);
      }
    } else if (msg.code === "buff" && ["heal", "shield", "speed"].includes(msg.buff) && player.alive) {
      if (msg.buff === "heal") {
        this.applyHeal(player, 9999); // remonte au maximum, applyHeal plafonne déjà
      } else if (msg.buff === "shield") {
        player.shield = true;
      } else if (msg.buff === "speed") {
        const durMs = (this.buffDurationSec || 10) * 1000;
        player.speedUntil = Math.max(player.speedUntil || 0, Date.now() + durMs);
      }
      this.pushLog(`${player.pseudo} a activé un code secret… 👀`);
      this.broadcastState(); // effet immédiat, contrairement aux deux codes ci-dessus
    }
  }

  handleAttack(player, msg) {
    const turn = this.turn;
    if (!turn || turn.playerId !== player.id) return;
    if (Date.now() > turn.deadline) return;
    const attack = turn.attack;
    this.turn = null;

    if (attack.nuke) {
      // On prévient tout le monde immédiatement (déclenche la cinématique côté client),
      // puis on applique réellement les dégâts après coup — sinon la partie pourrait se
      // terminer et afficher l'écran de victoire avant même que l'animation ne commence.
      this.pushLog(`${player.pseudo} déclenche ${attack.name} !`);
      this.broadcast({ type: "attackResolved", attackId: attack.id, by: player.id, cells: [], groups: null });
      this.broadcastState();
      const handle = setTimeout(() => {
        this.pendingAttacks.delete(handle);
        if (this.status !== "playing") return;
        const liveAttacker = this.players[player.id];
        if (!liveAttacker) return;
        this.resolveAttackEffects(liveAttacker, attack, msg, null);
        this.broadcastState();
      }, NUKE_RESOLVE_DELAY_MS);
      if (handle.unref) handle.unref();
      this.pendingAttacks.add(handle);
      if (this.status === "playing") this.scheduleTick(this.turnGapSec * 1000 + NUKE_RESOLVE_DELAY_MS);
      return;
    }

    const isDelayed = (!!attack.damage || attack.forceTelegraph) && !attack.trap && !attack.instant;

    if (!isDelayed) {
      const result = this.resolveAttackEffects(player, attack, msg, null);
      this.pushLog(`${player.pseudo} utilise ${attack.name} !`);
      this.broadcast({ type: "attackResolved", attackId: attack.id, by: player.id, cells: result.cells, groups: result.groups || null });
    } else {
      const cells = this.computeAttackCells(player, attack, msg);
      const delay = Math.round((attack.telegraphMs || DEFAULT_TELEGRAPH_MS) * this.telegraphMultiplier);
      const resolveAt = Date.now() + delay;
      this.pushLog(`${player.pseudo} prépare ${attack.name} !`);
      this.broadcast({ type: "telegraph", attackId: attack.id, by: player.id, cells, resolveAt });
      const telegraphEntry = { cells, resolveAt };
      this.activeTelegraphs.push(telegraphEntry);

      const handle = setTimeout(() => {
        this.pendingAttacks.delete(handle);
        this.activeTelegraphs = this.activeTelegraphs.filter(t => t !== telegraphEntry);
        if (this.status !== "playing") return;
        const liveAttacker = this.players[player.id];
        if (!liveAttacker) return;
        const result = this.resolveAttackEffects(liveAttacker, attack, msg, cells);
        this.broadcast({ type: "attackResolved", attackId: attack.id, by: liveAttacker.id, cells: result.cells, groups: result.groups || null });
        this.broadcastState();
      }, delay);
      if (handle.unref) handle.unref();
      this.pendingAttacks.add(handle);
    }

    this.broadcastState();
    if (this.status === "playing") this.scheduleTick(this.turnGapSec * 1000);
  }

  computeAttackCells(player, attack, msg) {
    if (attack.target === "zone" && attack.random) {
      const zone = this.cellsForZone(msg.x, msg.y, attack.size);
      const picks = [];
      for (let i = 0; i < (attack.hits || 1); i++) picks.push(zone[randInt(zone.length)]);
      return picks;
    }
    if (attack.target === "zone") {
      return this.cellsForZone(msg.x, msg.y, attack.size);
    }
    if (attack.target === "cell") {
      return this.inBounds(msg.x, msg.y) ? [{ x: msg.x, y: msg.y }] : [];
    }
    if (attack.target === "self") {
      const cells = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const x = player.x + dx, y = player.y + dy;
        if (this.inBounds(x, y)) cells.push({ x, y });
      }
      return cells;
    }
    if (attack.target === "line") {
      const axis = msg.axis === "col" ? "col" : "row";
      const step = axis === "row" ? [1, 0] : [0, 1];
      const cells = [{ x: msg.x, y: msg.y }];
      let cx = msg.x, cy = msg.y;
      while (true) {
        const nx = cx + step[0], ny = cy + step[1];
        if (!this.inBounds(nx, ny) || this.isWall(nx, ny)) break;
        cells.push({ x: nx, y: ny }); cx = nx; cy = ny;
      }
      cx = msg.x; cy = msg.y;
      while (true) {
        const nx = cx - step[0], ny = cy - step[1];
        if (!this.inBounds(nx, ny) || this.isWall(nx, ny)) break;
        cells.push({ x: nx, y: ny }); cx = nx; cy = ny;
      }
      return cells;
    }
    if (attack.target === "direction") {
      const dirs = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
      const d = dirs[msg.dir];
      if (!d) return []; // direction absente/invalide : aucun effet, ne doit jamais viser le lanceur
      let cx = player.x, cy = player.y;
      const cells = [];
      const maxSteps = attack.distance || this.gridSize;
      for (let step = 0; step < maxSteps; step++) {
        const nx = cx + d[0], ny = cy + d[1];
        if (!this.inBounds(nx, ny) || (!attack.piercesWalls && this.isWall(nx, ny))) break;
        cx = nx; cy = ny;
        cells.push({ x: cx, y: cy });
      }
      return cells;
    }
    return [];
  }

  // Retourne toujours { cells, groups }. `groups` (tableau de tableaux de cases)
  // n'est renseigné que pour les attaques "en rafale" (staggered côté client) —
  // il sert à afficher/jouer chaque impact un par un plutôt que tous en même temps.
  resolveAttackEffects(player, attack, msg, precomputedCells) {
    const hitPlayerAt = (x, y) => this.anyPlayerAt(x, y);
    let affected = [];
    let groups = null;

    if (precomputedCells) {
      const originalCells = precomputedCells.slice();
      for (const c of originalCells) {
        const hitP = hitPlayerAt(c.x, c.y);
        if (!hitP) continue;
        if (attack.damage) this.applyDamage(player.id, hitP, attack.damage);
        if (attack.root && hitP.alive) hitP.rootedUntil = Date.now() + (attack.rootMs || 3000);
        if (attack.slow && hitP.alive) hitP.slowedUntil = Date.now() + (attack.slowMs || 1500);
      }

      if (attack.pull) {
        for (const c of originalCells) {
          const hitP = hitPlayerAt(c.x, c.y);
          if (!hitP) continue;
          const dx = Math.sign(msg.x - hitP.x), dy = Math.sign(msg.y - hitP.y);
          const nx = hitP.x + dx, ny = hitP.y + dy;
          const blocked = !this.inBounds(nx, ny) || this.isBlocked(nx, ny) ||
            Object.values(this.players).some(pp => pp.alive && pp.id !== hitP.id && pp.x === nx && pp.y === ny);
          if (!blocked) { hitP.x = nx; hitP.y = ny; }
        }
      }

      if (attack.acidRain) {
        const zone = this.cellsForZone(msg.x, msg.y, attack.size);
        const drops = shuffle(zone).slice(0, Math.min(attack.drops || 10, zone.length));
        for (const d of drops) {
          this.hazards.push({ type: "poison", x: d.x, y: d.y, size: 1, damage: attack.dropDamage || 6, ticks: attack.dropTicks || 10, ownerId: player.id });
        }
        groups = drops.map(d => [d]);
      }

      const extra = this.triggerBarrelChain(player.id, originalCells);
      affected = originalCells.concat(extra);

      if (attack.poison) {
        this.hazards.push({ type: "poison", x: msg.x, y: msg.y, size: attack.size, damage: attack.damage, ticks: attack.ticks, ownerId: player.id });
      }
      if (attack.slow) {
        this.hazards.push({ type: "frost", x: msg.x, y: msg.y, size: attack.size, damage: Math.round((attack.damage || 0) / 2), ticks: attack.traceTicks || 6, slowMs: attack.slowMs || 1500, ownerId: player.id });
      }
      if (attack.healZone) {
        this.hazards.push({ type: "healzone", x: msg.x, y: msg.y, size: attack.size, heal: attack.heal, ticks: attack.ticks, ownerId: player.id });
      }
      if (attack.target === "direction" && attack.moveSelf) {
        const dest = originalCells[originalCells.length - 1] || { x: player.x, y: player.y };
        const occupied = !!this.anyPlayerAt(dest.x, dest.y, player.id);
        if (!occupied && !this.isBlocked(dest.x, dest.y)) { player.x = dest.x; player.y = dest.y; }
      }
      return { cells: affected, groups };
    }

    // ---- Effets instantanés : piège, téléportation, soin, bouclier, tirs directs, rafales ----
    if (attack.target === "cell" && attack.trap) {
      if (this.inBounds(msg.x, msg.y) && !this.isBlocked(msg.x, msg.y)) { this.hazards.push({ type: "mine", x: msg.x, y: msg.y, damage: attack.damage, ownerId: player.id }); affected = [{ x: msg.x, y: msg.y }]; }
    } else if (attack.target === "cell" && attack.teleport) {
      const origin = { x: player.x, y: player.y };
      const dist = Math.abs(msg.x - player.x) + Math.abs(msg.y - player.y);
      if (this.inBounds(msg.x, msg.y) && dist <= attack.range && !hitPlayerAt(msg.x, msg.y) && !this.isBlocked(msg.x, msg.y)) {
        player.x = msg.x; player.y = msg.y;
        affected = [origin, { x: msg.x, y: msg.y }];
      }
    } else if (attack.target === "cell" && attack.instant && attack.chain) {
      // L'éclair frappe toujours la case choisie (zone d'effet autour), même si
      // personne ne s'y trouve exactement, puis rebondit vers le joueur non
      // touché le plus proche, avec la même zone d'effet à chaque impact.
      const hitIds = new Set([player.id]); // la chaîne ne rebondit jamais sur son lanceur
      const splashRadius = attack.chainSplashRadius || 0;
      const hitPlayersNear = (x, y) => Object.values(this.players).filter(p =>
        p.alive && !hitIds.has(p.id) && Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) <= splashRadius);

      let dmg = attack.damage, hops = 0;
      const maxHops = attack.chainHops || 3;
      const chainCells = [{ x: msg.x, y: msg.y }]; // l'impact initial est toujours affiché
      let cx = msg.x, cy = msg.y;

      while (hops <= maxHops) {
        for (const p of hitPlayersNear(cx, cy)) {
          this.applyDamage(player.id, p, Math.round(dmg));
          hitIds.add(p.id);
          chainCells.push({ x: p.x, y: p.y });
        }
        dmg *= (attack.chainFalloff !== undefined ? attack.chainFalloff : 0.75);
        hops++;
        if (hops > maxHops) break;
        const next = this.nearestAliveExcluding(cx, cy, hitIds);
        if (!next) break;
        cx = next.x; cy = next.y;
      }

      // Paratonnerre (carte Labo) : mini-explosion si l'éclair passe à proximité.
      for (const rod of (this.obstacles.lightningRod || [])) {
        const nearChain = chainCells.some(c => Math.max(Math.abs(c.x - rod.x), Math.abs(c.y - rod.y)) <= LIGHTNING_ROD_RADIUS);
        if (!nearChain) continue;
        this.pushLog("⚡ Un paratonnerre déclenche une mini-explosion !");
        const rodCells = this.cellsForZone(rod.x, rod.y, 3);
        for (const rc of rodCells) {
          const rp = this.anyPlayerAt(rc.x, rc.y);
          if (rp) this.applyDamage(player.id, rp, LIGHTNING_ROD_BONUS_DAMAGE);
        }
        chainCells.push(...rodCells);
      }

      affected = chainCells.concat(this.triggerBarrelChain(player.id, chainCells));
      groups = chainCells.map(c => [c]);
    } else if (attack.target === "cell" && attack.instant && !attack.subSize) {
      if (this.inBounds(msg.x, msg.y)) {
        affected = [{ x: msg.x, y: msg.y }];
        const hitP = hitPlayerAt(msg.x, msg.y);
        if (hitP) this.applyDamage(player.id, hitP, attack.damage);
        affected = affected.concat(this.triggerBarrelChain(player.id, [{ x: msg.x, y: msg.y }]));
      }
    } else if (attack.target === "line" && attack.instant) {
      const cells = this.computeAttackCells(player, attack, msg);
      affected = cells.slice();
      for (const c of affected) { const hitP = hitPlayerAt(c.x, c.y); if (hitP) this.applyDamage(player.id, hitP, attack.damage); }
      affected = affected.concat(this.triggerBarrelChain(player.id, affected));
    } else if (attack.target === "direction" && attack.instant) {
      const cells = this.computeAttackCells(player, attack, msg);
      affected = cells.slice();
      for (const c of affected) { const hitP = hitPlayerAt(c.x, c.y); if (hitP) this.applyDamage(player.id, hitP, attack.damage); }
      affected = affected.concat(this.triggerBarrelChain(player.id, affected));
      if (attack.moveSelf) {
        const dest = cells[cells.length - 1] || { x: player.x, y: player.y };
        const occupied = !!this.anyPlayerAt(dest.x, dest.y, player.id);
        if (!occupied && !this.isBlocked(dest.x, dest.y)) { player.x = dest.x; player.y = dest.y; }
      }
    } else if (attack.target === "self" && attack.nuke) {
      // Bombe nucléaire : one-shot tout le monde, y compris le lanceur — personne n'est épargné.
      // Dégâts appliqués directement (pas d'applyDamage) pour ignorer bouclier/protection
      // et éviter toute fin de partie prématurée pendant la boucle : tout le monde perd, sans exception.
      const victims = Object.values(this.players).filter(p => p.alive);
      for (const v of victims) { v.alive = false; v.hp = 0; v.timesKO += 1; }
      affected = victims.map(v => ({ x: v.x, y: v.y }));
      this.pushLog("☢️ La bombe nucléaire n'épargne personne...");
      this.endGame([], "nuke");
    } else if (attack.target === "self" && attack.earthquake) {
      // Séisme : petits dégâts à tout le monde (y compris le lanceur), et chacun
      // est poussé d'une case dans une direction aléatoire si la place est libre.
      const victims = Object.values(this.players).filter(p => p.alive);
      const dirOptions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const v of victims) {
        this.applyDamage(player.id, v, attack.damage);
        if (!v.alive) continue;
        for (const [dx, dy] of shuffle(dirOptions)) {
          const nx = v.x + dx, ny = v.y + dy;
          if (!this.inBounds(nx, ny) || this.isBlocked(nx, ny)) continue;
          const occupied = !!this.anyPlayerAt(nx, ny, v.id);
          if (occupied) continue;
          v.x = nx; v.y = ny;
          break;
        }
      }
      affected = victims.map(v => ({ x: v.x, y: v.y }));
    } else if (attack.target === "self" && attack.instant && !attack.shield) {
      const cells = this.computeAttackCells(player, attack, msg);
      affected = cells.slice();
      for (const c of affected) { const hitP = hitPlayerAt(c.x, c.y); if (hitP) this.applyDamage(player.id, hitP, attack.damage); }
      affected = affected.concat(this.triggerBarrelChain(player.id, affected));
    } else if (attack.target === "self" && attack.shield) {
      player.shield = true;
      affected = [{ x: player.x, y: player.y }];
    } else if (attack.target === "cell" && attack.instant && attack.subSize) {
      // Chute de napalme : un brasier 3x3 tourne façon moulinet dans les 4 coins
      // d'une zone 5x5 ancrée sur la case choisie (schéma fixe, aucun hasard de
      // position), et laisse des flammes derrière lui.
      let all = [];
      const grp = [];
      const offsets = attack.offsets || [[0, 0]];
      for (const [ox, oy] of offsets) {
        const cx = msg.x + ox, cy = msg.y + oy;
        const subCells = this.cellsForZone(cx, cy, attack.subSize);
        for (const c of subCells) { const hitP = hitPlayerAt(c.x, c.y); if (hitP) this.applyDamage(player.id, hitP, attack.damage); }
        all = all.concat(subCells);
        grp.push(subCells);
        if (attack.leavesFire) {
          this.hazards.push({ type: "fire", x: cx, y: cy, size: attack.subSize, damage: attack.fireDamage || 7, ticks: attack.fireTicks || 4, ownerId: player.id });
        }
      }
      affected = all.concat(this.triggerBarrelChain(player.id, all));
      groups = grp;
    } else if (attack.target === "zone" && attack.random && attack.instant) {
      const zone = this.cellsForZone(msg.x, msg.y, attack.size);
      const picks = [];
      for (let i = 0; i < (attack.hits || 1); i++) picks.push(zone[randInt(zone.length)]);
      for (const c of picks) { const hitP = hitPlayerAt(c.x, c.y); if (hitP) this.applyDamage(player.id, hitP, attack.damage); }
      affected = picks.concat(this.triggerBarrelChain(player.id, picks));
      groups = picks.map(c => [c]);
    } else if (attack.target === "ally") {
      const targetId = msg.targetId || player.id;
      const target = this.players[targetId];
      if (target && target.alive) {
        const dist = Math.abs(target.x - player.x) + Math.abs(target.y - player.y);
        if (target.id === player.id || dist <= 2) { this.applyHeal(target, attack.heal); affected = [{ x: target.x, y: target.y }]; }
      }
    }
    return { cells: affected, groups };
  }

  hillTick() {
    if (this.status !== "playing" || (this.mode !== "kingHill" && this.mode !== "zoneMobile")) { clearInterval(this.hillTimer); return; }
    let changed = false;
    if (this.mode === "zoneMobile" && Date.now() - this.lastHillMoveAt >= HILL_MOVE_INTERVAL_SEC * 1000) {
      const spot = this.freeSpawn();
      this.movingHillPos = { x: spot.x, y: spot.y };
      this.lastHillMoveAt = Date.now();
      this.pushLog("🎯 La zone à tenir se déplace !");
      changed = true;
    }
    for (const p of Object.values(this.players)) {
      if (p.alive && this.onHill(p.x, p.y)) { p.score += 1; changed = true; }
    }
    if (changed) {
      this.broadcastState();
      this.checkWinCondition();
    }
  }

  // ---- IA simple du bot (mode Boss) : se rapproche du joueur le plus proche
  // et utilise son arme automatiquement, avec un petit délai façon "réflexion". ----
  maybeBotAct() {
    const stillInCountdown = Date.now() - this.matchStartedAt < BOT_START_GRACE_MS;
    for (const bot of Object.values(this.players).filter(p => p.isBot && p.alive)) {
      if (stillInCountdown) continue; // reste immobile pendant le "3, 2, 1, GO !"

      this.botTryDodge(bot);
      const rooted = bot.rootedUntil && Date.now() < bot.rootedUntil;
      const fled = rooted ? false : this.botTryFlee(bot);

      if (!fled && !rooted) {
        const maxHp = (this.bossId === bot.id) ? Math.round(this.startingHP * this.bossHpMultiplier) : this.startingHP;
        const onHealingZone = bot.hp < maxHp && this.hazards.some(h =>
          h.type === "healzone" && this.cellsForZone(h.x, h.y, h.size).some(c => c.x === bot.x && c.y === bot.y));
        // Comportement neutre : ne traque jamais un joueur. Bouge au hasard une
        // fois sur deux environ, ou reste immobile — et reste volontairement sur
        // une zone de soin tant qu'il n'a pas récupéré tous ses PV.
        if (!onHealingZone && Math.random() < BOT_RANDOM_MOVE_CHANCE) {
          for (const [dx, dy] of shuffle([[1, 0], [-1, 0], [0, 1], [0, -1]])) {
            const m = { x: bot.x + dx, y: bot.y + dy };
            if (this.inBounds(m.x, m.y) && !this.isBlocked(m.x, m.y)) { this.handleMove(bot, m); break; }
          }
        }
      }

      if (this.turn && this.turn.playerId === bot.id && !bot._botActionPending) {
        bot._botActionPending = true;
        const [minMs, maxMs] = BOT_ATTACK_DELAY_MS[bot.botDifficulty || "medium"];
        const handle = setTimeout(() => {
          bot._botActionPending = false;
          this.pendingAttacks.delete(handle);
          if (this.status === "playing" && this.turn && this.turn.playerId === bot.id) this.botFireAttack(bot);
        }, minMs + randInt(maxMs - minMs));
        if (handle.unref) handle.unref();
        this.pendingAttacks.add(handle);
      }
    }
  }

  // Tente d'esquiver les attaques téléphonées en cours, selon la difficulté du bot.
  // Le tirage au sort (esquive ou non) n'a lieu qu'une fois par télégraphe ; une fois
  // décidé à fuir, le bot continue de s'éloigner du centre du danger à chaque tick.
  botTryDodge(bot) {
    if (!this.activeTelegraphs.length) return;
    for (const tg of this.activeTelegraphs) {
      const inDanger = tg.cells.some(c => c.x === bot.x && c.y === bot.y);
      if (!tg.dodgeRoll) tg.dodgeRoll = new Map();
      if (!tg.dodgeRoll.has(bot.id)) {
        const chance = BOT_DODGE_CHANCE[bot.botDifficulty || "medium"];
        tg.dodgeRoll.set(bot.id, inDanger && Math.random() < chance);
      }
      if (!inDanger || !tg.dodgeRoll.get(bot.id)) continue;

      const cx = tg.cells.reduce((s, c) => s + c.x, 0) / tg.cells.length;
      const cy = tg.cells.reduce((s, c) => s + c.y, 0) / tg.cells.length;
      const candidates = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .map(([dx, dy]) => ({ x: bot.x + dx, y: bot.y + dy }))
        .filter(m => this.inBounds(m.x, m.y) && !this.isBlocked(m.x, m.y));
      if (!candidates.length) continue;
      candidates.sort((a, b) => Math.hypot(b.x - cx, b.y - cy) - Math.hypot(a.x - cx, a.y - cy));
      this.handleMove(bot, candidates[0]); // s'éloigne autant que possible du centre du danger
    }
  }

  // Fuit une zone dangereuse (hors zone qui rétrécit, poison/feu/givre) ou une
  // attaque de mêlée sur le point d'être utilisée à proximité — selon la difficulté.
  // Retourne true si le bot a effectivement tenté de fuir ce tick.
  botTryFlee(bot) {
    const chance = BOT_DODGE_CHANCE[bot.botDifficulty || "medium"];
    if (Math.random() > chance) return false;

    if (this.shrinkEnabled && this.isVoid(bot.x, bot.y)) {
      const c = this.shrinkCenter();
      this.botStepToward(bot, c.x, c.y);
      return true;
    }
    const hazard = this.hazards.find(h =>
      (h.type === "poison" || h.type === "fire" || h.type === "frost") &&
      this.cellsForZone(h.x, h.y, h.size).some(c => c.x === bot.x && c.y === bot.y));
    if (hazard) { this.botStepAway(bot, hazard.x, hazard.y); return true; }

    if (this.turn && this.turn.playerId !== bot.id && BOT_FLEE_ATTACKS.has(this.turn.attack.id)) {
      const attacker = this.players[this.turn.playerId];
      if (attacker && attacker.alive) {
        const dist = Math.abs(attacker.x - bot.x) + Math.abs(attacker.y - bot.y);
        if (dist <= 3) { this.botStepAway(bot, attacker.x, attacker.y); return true; }
      }
    }
    return false;
  }

  botStepToward(bot, tx, ty) {
    const dx = Math.sign(tx - bot.x), dy = Math.sign(ty - bot.y);
    const moves = [];
    if (dx !== 0) moves.push({ x: bot.x + dx, y: bot.y });
    if (dy !== 0) moves.push({ x: bot.x, y: bot.y + dy });
    for (const m of shuffle(moves)) this.handleMove(bot, m);
  }

  botStepAway(bot, fromX, fromY) {
    let dx = Math.sign(bot.x - fromX), dy = Math.sign(bot.y - fromY);
    if (dx === 0 && dy === 0) { dx = randInt(2) ? 1 : -1; dy = randInt(2) ? 1 : -1; }
    const moves = [];
    if (dx !== 0) moves.push({ x: bot.x + dx, y: bot.y });
    if (dy !== 0) moves.push({ x: bot.x, y: bot.y + dy });
    for (const m of shuffle(moves)) this.handleMove(bot, m);
  }

  botFireAttack(bot) {
    const attack = this.turn.attack;
    const needsAlignment = attack.target === "direction" || attack.target === "line";
    const target = this.botPickTarget(bot, needsAlignment) || bot;
    let msg = { x: target.x, y: target.y };
    if (attack.target === "direction") {
      const dx = target.x - bot.x, dy = target.y - bot.y;
      msg = { dir: Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy >= 0 ? "down" : "up") };
    } else if (attack.target === "line") {
      msg.axis = Math.abs(target.x - bot.x) > Math.abs(target.y - bot.y) ? "row" : "col";
    } else if (attack.target === "ally") {
      msg = { targetId: bot.id }; // simplicité : le bot se soigne lui-même
    } else if (attack.healZone) {
      msg = { x: bot.x, y: bot.y }; // une zone de soin se pose toujours sur soi, jamais sur un adversaire
    }
    this.handleAttack(bot, msg);
  }

  // ---- Modificateurs de carte (cumulables) : météorites, orage, séisme, pluie acide, cimetière ----
  tickMapModifiers() {
    if (!this.mapModifiers || !this.mapModifiers.length) return;
    const now = Date.now();
    for (const m of this.mapModifiers) {
      if (now < (this.modifierNextAt[m] || 0)) continue;
      this.fireMapModifier(m);
      const [lo, hi] = modifierIntervalSec(this, m);
      this.modifierNextAt[m] = now + (lo + Math.random() * (hi - lo)) * 1000;
    }
    this.tickZombies();
  }

  fireMapModifier(id) {
    const alive = Object.values(this.players).filter(p => p.alive);
    const s = this.modifierSettings[id] || {};
    if (id === "meteorRain") {
      const x = randInt(this.gridSize), y = randInt(this.gridSize);
      const cells = this.cellsForZone(x, y, 3);
      for (const c of cells) {
        const p = alive.find(pl => this.playerOccupiesCell(pl, c.x, c.y));
        if (p) this.applyDamage(null, p, s.damage);
      }
      this.broadcast({ type: "mapEvent", kind: "meteorRain", cells });
      this.pushLog("☄️ Une météorite s'écrase !");
    } else if (id === "storm") {
      if (!alive.length) return;
      const target = alive[randInt(alive.length)];
      this.applyDamage(null, target, s.damage);
      this.broadcast({ type: "mapEvent", kind: "storm", cells: [{ x: target.x, y: target.y }] });
      this.pushLog("🌩️ La foudre frappe !");
    } else if (id === "earthquakeMod") {
      const cells = alive.map(p => ({ x: p.x, y: p.y }));
      for (const p of alive) this.applyDamage(null, p, s.damage);
      this.broadcast({ type: "mapEvent", kind: "earthquakeMod", cells });
      this.pushLog("🌍 Le sol tremble !");
    } else if (id === "acidRainMod") {
      const x = randInt(this.gridSize), y = randInt(this.gridSize);
      const size = Math.round(s.size);
      this.hazards.push({ type: "poison", x, y, size, damage: s.damage, ticks: 4, ownerId: null });
      this.broadcast({ type: "mapEvent", kind: "acidRainMod", cells: this.cellsForZone(x, y, size) });
      this.pushLog("🧪 Une pluie acide tombe...");
    } else if (id === "cemetery") {
      if (this.zombies.length >= ZOMBIE_MAX_ALIVE) return;
      const spot = this.freeSpawn();
      this.zombies.push({ id: crypto.randomUUID(), x: spot.x, y: spot.y, hp: s.zombieHp });
      this.pushLog("🧟 Une ombre surgit du cimetière...");
    }
  }

  tickZombies() {
    if (!this.zombies || !this.zombies.length) return;
    for (const z of this.zombies.slice()) {
      const target = this.nearestAliveExcluding(z.x, z.y, new Set());
      if (target) {
        const dx = Math.sign(target.x - z.x), dy = Math.sign(target.y - z.y);
        const moves = shuffle([[dx, 0], [0, dy]].filter(([a, b]) => a !== 0 || b !== 0));
        for (const [mx, my] of moves) {
          const nx = z.x + mx, ny = z.y + my;
          if (this.inBounds(nx, ny) && !this.isBlocked(nx, ny)) { z.x = nx; z.y = ny; break; }
        }
      }
      const hitP = this.anyPlayerAt(z.x, z.y);
      if (hitP) {
        this.applyDamage(null, hitP, (this.modifierSettings.cemetery && this.modifierSettings.cemetery.explosionDamage) || ZOMBIE_EXPLOSION_DAMAGE);
        this.zombies = this.zombies.filter(zz => zz.id !== z.id);
        this.pushLog(`💥 Une ombre explose sur ${hitP.pseudo} !`);
      }
    }
  }

  secondTick() {
    if (this.status !== "playing") return;

    if (this.mode === "infection" && this.infectionEndAt && Date.now() >= this.infectionEndAt) {
      const humans = Object.values(this.players).filter(p => !p.infected).map(p => p.id);
      this.endGame(humans, "infection");
      return;
    }

    this.purgeStaleDisconnected();
    this.maybeBotAct();

    for (const p of Object.values(this.players)) {
      if (!p.alive && p.respawnAt && Date.now() >= p.respawnAt) {
        const spawn = this.freeSpawn(p.size);
        p.alive = true; p.hp = Math.round(this.startingHP * (this.respawnHpPercent / 100)); p.x = spawn.x; p.y = spawn.y; p.respawnAt = null;
        p.invulnUntil = this.spawnProtectionSec > 0 ? Date.now() + this.spawnProtectionSec * 1000 : null;
        this.pushLog(`${p.pseudo} revient dans l'arène.`);
      }
    }

    if (this.passiveRegenPerSec > 0) {
      for (const p of Object.values(this.players)) {
        if (p.alive && p.hp < this.startingHP) this.applyHeal(p, this.passiveRegenPerSec);
      }
    }

    // Zones de soin de la carte (carte Labo) : soigne quiconque reste dessus.
    for (const p of Object.values(this.players)) {
      if (p.alive && p.hp < this.startingHP && this.isHeal(p.x, p.y)) this.applyHeal(p, HEAL_TILE_PER_SEC);
    }

    this.tickMapModifiers();

    this.hazards = this.hazards.filter(h => {
      if (h.type !== "poison" && h.type !== "frost" && h.type !== "fire" && h.type !== "healzone") return true;
      const cells = this.cellsForZone(h.x, h.y, h.size);
      const owner = h.ownerId ? this.players[h.ownerId] : null;
      for (const p of Object.values(this.players)) {
        if (!p.alive || !cells.some(c => c.x === p.x && c.y === p.y)) continue;
        if (h.type === "healzone") {
          if (this.teamsEnabled && owner && owner.team && p.team !== owner.team) continue; // ne soigne pas les ennemis
          this.applyHeal(p, h.heal);
        } else {
          this.applyDamage(h.ownerId, p, h.damage);
          if (h.type === "frost" && p.alive) p.slowedUntil = Date.now() + (h.slowMs || 1500);
        }
      }
      h.ticks -= 1;
      return h.ticks > 0;
    });

    if (this.status !== "playing") return;

    if (this.shrinkEnabled) {
      if (this.shrinkMode !== "onKO" && this.shrinkRadius > SHRINK_MIN_RADIUS &&
          Date.now() - this.lastShrinkAt >= this.shrinkIntervalSec * 1000) {
        this.shrinkRadius -= 1;
        this.lastShrinkAt = Date.now();
        this.pushLog("⚠️ La zone se rétrécit !");
      }
      for (const p of Object.values(this.players)) {
        if (p.alive && this.isVoid(p.x, p.y)) this.applyDamage(null, p, SHRINK_DAMAGE_PER_SEC);
      }
      if (this.status !== "playing") return;
    }

    if (this.powerupsEnabled) {
      const intervalMs = this.powerupIntervalSec * 1000;
      if (Date.now() - this.lastPowerupSpawn >= intervalMs && this.powerups.length < this.powerupMaxOnMap) {
        const spot = this.freeSpawn();
        const type = POWERUP_TYPES[randInt(POWERUP_TYPES.length)];
        this.powerups.push({ id: crypto.randomUUID(), x: spot.x, y: spot.y, type });
        this.lastPowerupSpawn = Date.now();
      }
    }

    if (this.mode === "treasureHunt") {
      const intervalMs = TREASURE_SPAWN_INTERVAL_SEC * 1000;
      if (Date.now() - this.lastTreasureSpawn >= intervalMs && this.treasures.length < TREASURE_MAX_ON_MAP) {
        const spot = this.freeSpawn();
        this.treasures.push({ id: crypto.randomUUID(), x: spot.x, y: spot.y });
        this.lastTreasureSpawn = Date.now();
      }
    }

    this.broadcastState();
  }

  resolveChronoEnd() {
    const list = Object.values(this.players);

    if (this.teamsEnabled) {
      const teamsPresent = [...new Set(list.map(p => p.team).filter(Boolean))];
      const sums = teamsPresent.map(t => ({ t, sum: list.filter(p => p.team === t).reduce((s, p) => s + p.eliminations, 0) }));
      const max = sums.reduce((m, s) => Math.max(m, s.sum), 0);
      const top = sums.filter(s => s.sum === max && max > 0).map(s => s.t);
      if (top.length === 1) { this.endGame(list.filter(p => p.team === top[0]).map(p => p.id), "chrono"); return; }
      if (top.length > 1) {
        this.suddenDeath = true;
        this.suddenDeathIds = new Set(list.filter(p => top.includes(p.team)).map(p => p.id));
        this.chronoEndAt = null;
        this.pushLog("Égalité entre équipes ! Mort subite : le prochain K.O. gagne.");
        this.broadcastState();
        return;
      }
      this.endGame([], "chrono");
      return;
    }

    const maxKO = list.reduce((m, p) => Math.max(m, p.eliminations), 0);
    const top = list.filter(p => p.eliminations === maxKO && maxKO > 0);
    if (top.length === 1) { this.endGame([top[0].id], "chrono"); return; }
    if (top.length > 1) {
      this.suddenDeath = true;
      this.suddenDeathIds = new Set(top.map(p => p.id));
      this.chronoEndAt = null;
      this.pushLog("Égalité ! Mort subite : le prochain K.O. gagne.");
      this.broadcastState();
      return;
    }
    this.endGame([], "chrono");
  }

  pickNextAttacker() {
    while (this.turnQueue.length) {
      const id = this.turnQueue.shift();
      const p = this.players[id];
      if (p && p.alive) return p;
    }
    const alive = Object.values(this.players).filter(p => p.alive).map(p => p.id);
    if (alive.length === 0) return null;
    this.turnQueue = shuffle(alive);
    const id = this.turnQueue.shift();
    return this.players[id] || null;
  }

  // Tirage pondéré : la plupart des armes ont un poids de 1 (probabilité normale),
  // les armes rarissimes (napalm, pluie acide) ont un poids très inférieur à 1.
  pickWeightedAttack() {
    const weightFor = (a) => {
      const base = a.weight !== undefined ? a.weight : 1;
      const override = this.attackWeightOverrides[a.id];
      return override !== undefined ? base * override : base;
    };
    const total = this.attacksRuntime.reduce((s, a) => s + weightFor(a), 0);
    if (total <= 0) return this.attacksRuntime[randInt(this.attacksRuntime.length)]; // repli si l'hôte a tout mis à 0%
    let r = Math.random() * total;
    for (const a of this.attacksRuntime) {
      const w = weightFor(a);
      if (r < w) return a;
      r -= w;
    }
    return this.attacksRuntime[this.attacksRuntime.length - 1];
  }

  tick() {
    if (this.status !== "playing") return;
    const now = Date.now();

    if (this.mode === "chrono" && this.chronoEndAt && now >= this.chronoEndAt && !this.suddenDeath) {
      this.resolveChronoEnd();
      if (this.status !== "playing") return;
      this.scheduleTick(this.turnGapSec * 1000);
      return;
    }

    if (this.turn && now > this.turn.deadline) {
      const p = this.players[this.turn.playerId];
      this.pushLog(`${p ? p.pseudo : "Le joueur"} n'a pas utilisé son arme à temps.`);
      this.turn = null;
      this.broadcastState();
      this.scheduleTick(this.turnGapSec * 1000);
      return;
    }

    if (!this.turn) {
      const chosen = this.pickNextAttacker();
      if (!chosen) { this.scheduleTick(1000); return; }
      let attack, altAttack = null;
      if (chosen.forcedNextAttackId) {
        attack = this.attacksRuntime.find(a => a.id === chosen.forcedNextAttackId) || ATTACKS.find(a => a.id === chosen.forcedNextAttackId);
        chosen.forcedNextAttackId = null;
      } else {
        attack = this.pickWeightedAttack();
        if (this.weaponNoRepeat && this.attacksRuntime.length > 1) {
          let guard = 0;
          while (attack.id === this.lastAttackId && guard < 10) { attack = this.pickWeightedAttack(); guard++; }
        }
        if (this.twoWeaponHand && this.attacksRuntime.length > 1) {
          let guard = 0;
          do { altAttack = this.pickWeightedAttack(); guard++; } while (altAttack.id === attack.id && guard < 10);
          if (altAttack.id === attack.id) altAttack = null; // aucune autre arme distincte disponible
        }
      }
      this.lastAttackId = attack.id;
      const deadline = Date.now() + this.attackWindowSec * 1000;
      this.turn = { playerId: chosen.id, attack, altAttack, deadline };
      // Charge : un peu plus vif tant qu'on l'a en main, pour repositionner son élan.
      if (attack.id === "charge") chosen.speedUntil = Math.max(chosen.speedUntil || 0, deadline);
      this.pushLog(`${chosen.pseudo} reçoit : ${attack.name} !`);
      this.broadcastState();
      this.scheduleTick(this.attackWindowSec * 1000 + 200);
    } else {
      this.scheduleTick(1000);
    }
  }
}

// ---- Mode Duo : combat de fusées en ligne, 2 joueurs, salle légère à part ----
// ---- Mode Duo : Bataille Navale en ligne, tour par tour, chacun sur son appareil ----
const BS_GRID = 9;
const BS_SHIPS = [5, 4, 3, 3, 2, 2]; // tailles des navires à placer
const DUO_IDLE_CLEANUP_MS = 1000 * 60 * 30;

function bsEmptyGrid() { return Array.from({ length: BS_GRID }, () => Array(BS_GRID).fill(null)); }
// Valide un placement de navires envoyé par le client et construit le plateau serveur correspondant.
function bsValidatePlacement(shipsInput) {
  if (!Array.isArray(shipsInput)) return { ok: false, error: "Format de placement invalide." };
  const required = BS_SHIPS.slice().sort((a, b) => a - b);
  const given = shipsInput.map(s => s && s.size).sort((a, b) => a - b);
  if (JSON.stringify(required) !== JSON.stringify(given)) return { ok: false, error: "La liste des navires ne correspond pas." };
  const board = bsEmptyGrid();
  const ships = [];
  let nextId = 1;
  for (const s of shipsInput) {
    const r = parseInt(s.r, 10), c = parseInt(s.c, 10), size = parseInt(s.size, 10), dir = s.dir === 1 ? 1 : 0;
    if (!Number.isInteger(r) || !Number.isInteger(c) || !Number.isInteger(size)) return { ok: false, error: "Navire invalide." };
    const cells = [];
    for (let i = 0; i < size; i++) {
      const rr = dir === 1 ? r + i : r;
      const cc = dir === 0 ? c + i : c;
      if (rr < 0 || rr >= BS_GRID || cc < 0 || cc >= BS_GRID) return { ok: false, error: "Un navire dépasse de la grille." };
      if (board[rr][cc]) return { ok: false, error: "Deux navires se chevauchent." };
      cells.push([rr, cc]);
    }
    const id = nextId++;
    for (const [rr, cc] of cells) board[rr][cc] = id;
    ships.push({ id, size, hits: 0, sunk: false });
  }
  return { ok: true, board, ships };
}

class DuoRoom {
  constructor(code) {
    this.code = code;
    this.game = "battleship";
    this.players = new Map(); // num(1|2) -> joueur
    this.status = "waiting"; // waiting -> placing -> playing -> ended
    this.turn = 1;
    this.winner = null;
    this.lastActivity = Date.now();
  }
  freshPlayerState(ws, pseudo, num) {
    return {
      ws, pseudo: (pseudo || `Joueur ${num}`).slice(0, 16), num, connected: true, ready: false,
      board: bsEmptyGrid(), ships: [], shotsMade: bsEmptyGrid(), shotsReceived: bsEmptyGrid(),
    };
  }
  addPlayer(ws, pseudo) {
    if (this.players.size >= 2) return null;
    const num = this.players.size + 1;
    const player = this.freshPlayerState(ws, pseudo, num);
    this.players.set(num, player);
    this.lastActivity = Date.now();
    if (this.players.size === 2) this.status = "placing";
    this.broadcast();
    return player;
  }
  removePlayer(num) {
    const p = this.players.get(num);
    if (!p) return;
    p.connected = false;
    if (this.status === "playing" || this.status === "placing") {
      this.status = "ended";
      this.winner = num === 1 ? 2 : 1;
    }
    this.broadcast();
  }
  handlePlace(num, shipsInput) {
    if (this.status !== "placing") return;
    const p = this.players.get(num);
    if (!p || p.ready) return;
    const result = bsValidatePlacement(shipsInput);
    this.lastActivity = Date.now();
    if (!result.ok) {
      if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify({ type: "duoPlaceError", message: result.error }));
      return;
    }
    p.board = result.board;
    p.ships = result.ships;
    p.ready = true;
    const other = this.players.get(num === 1 ? 2 : 1);
    if (other && other.ready) { this.status = "playing"; this.turn = 1; }
    this.broadcast();
  }
  handleFire(num, r, c) {
    if (this.status !== "playing" || this.turn !== num) return;
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= BS_GRID || c < 0 || c >= BS_GRID) return;
    const opponentNum = num === 1 ? 2 : 1;
    const me = this.players.get(num), opp = this.players.get(opponentNum);
    if (!me || !opp || me.shotsMade[r][c]) return;
    this.lastActivity = Date.now();
    const shipId = opp.board[r][c];
    const hit = !!shipId;
    me.shotsMade[r][c] = hit ? "hit" : "miss";
    opp.shotsReceived[r][c] = hit ? "hit" : "miss";
    if (hit) {
      const ship = opp.ships.find(s => s.id === shipId);
      ship.hits++;
      if (ship.hits >= ship.size) {
        ship.sunk = true;
        // Marque toutes les cases de ce navire en "sunk" (au lieu de "hit") des deux côtés,
        // pour que le client sache exactement quel navire vient d'être coulé et l'affiche en entier.
        for (let rr = 0; rr < BS_GRID; rr++) for (let cc = 0; cc < BS_GRID; cc++) {
          if (opp.board[rr][cc] === shipId) {
            opp.shotsReceived[rr][cc] = "sunk";
            me.shotsMade[rr][cc] = "sunk";
          }
        }
      }
    }
    if (opp.ships.every(s => s.sunk)) { this.status = "ended"; this.winner = num; }
    else { this.turn = opponentNum; }
    this.broadcast();
  }
  restart() {
    for (const [num, p] of this.players.entries()) {
      this.players.set(num, this.freshPlayerState(p.ws, p.pseudo, num));
      this.players.get(num).connected = p.connected;
    }
    this.status = this.players.size === 2 ? "placing" : "waiting";
    this.turn = 1;
    this.winner = null;
    this.lastActivity = Date.now();
    this.broadcast();
  }
  publicStateFor(viewerNum) {
    const opponentNum = viewerNum === 1 ? 2 : 1;
    const me = this.players.get(viewerNum);
    const opp = this.players.get(opponentNum);
    return {
      type: "duoState", status: this.status, turn: this.turn, myNum: viewerNum, winner: this.winner,
      gridSize: BS_GRID, shipSizes: BS_SHIPS,
      me: me ? {
        pseudo: me.pseudo, connected: me.connected, ready: me.ready,
        board: me.board, shotsReceived: me.shotsReceived,
        shipsSunk: me.ships.filter(s => s.sunk).length, totalShips: BS_SHIPS.length,
      } : null,
      opponent: opp ? {
        pseudo: opp.pseudo, connected: opp.connected, ready: opp.ready,
        shipsSunk: opp.ships.filter(s => s.sunk).length, totalShips: BS_SHIPS.length,
      } : null,
      myShots: me ? me.shotsMade : null,
    };
  }
  broadcast() {
    for (const [num, p] of this.players.entries()) {
      if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(this.publicStateFor(num)));
    }
  }
}

// ================= MODE DUO : PUISSANCE 4 EN LIGNE =================
const C4_ROWS = 6, C4_COLS = 7;
function c4EmptyBoard() { return Array.from({ length: C4_ROWS }, () => Array(C4_COLS).fill(null)); }
function c4CheckWin(board, r, c, num) {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (let s = 1; s < 4; s++) { const rr = r + dr * s, cc = c + dc * s; if (rr < 0 || rr >= C4_ROWS || cc < 0 || cc >= C4_COLS || board[rr][cc] !== num) break; count++; }
    for (let s = 1; s < 4; s++) { const rr = r - dr * s, cc = c - dc * s; if (rr < 0 || rr >= C4_ROWS || cc < 0 || cc >= C4_COLS || board[rr][cc] !== num) break; count++; }
    if (count >= 4) return true;
  }
  return false;
}
class Connect4Room {
  constructor(code) {
    this.code = code;
    this.game = "connect4";
    this.players = new Map();
    this.status = "waiting"; // waiting -> playing -> ended
    this.board = c4EmptyBoard();
    this.turn = 1;
    this.winner = null;
    this.lastActivity = Date.now();
  }
  addPlayer(ws, pseudo) {
    if (this.players.size >= 2) return null;
    const num = this.players.size + 1;
    const player = { ws, pseudo: (pseudo || `Joueur ${num}`).slice(0, 16), num, connected: true };
    this.players.set(num, player);
    this.lastActivity = Date.now();
    if (this.players.size === 2) this.status = "playing";
    this.broadcast();
    return player;
  }
  removePlayer(num) {
    const p = this.players.get(num);
    if (!p) return;
    p.connected = false;
    if (this.status === "playing") { this.status = "ended"; this.winner = num === 1 ? 2 : 1; }
    this.broadcast();
  }
  handleDrop(num, col) {
    if (this.status !== "playing" || this.turn !== num) return;
    if (!Number.isInteger(col) || col < 0 || col >= C4_COLS) return;
    let row = -1;
    for (let r = C4_ROWS - 1; r >= 0; r--) if (!this.board[r][col]) { row = r; break; }
    if (row < 0) return; // colonne pleine
    this.board[row][col] = num;
    this.lastActivity = Date.now();
    if (c4CheckWin(this.board, row, col, num)) { this.status = "ended"; this.winner = num; }
    else if (this.board.every(r => r.every(c => c))) { this.status = "ended"; this.winner = null; } // match nul
    else this.turn = num === 1 ? 2 : 1;
    this.broadcast();
  }
  restart() {
    this.board = c4EmptyBoard();
    this.turn = 1;
    this.winner = null;
    this.status = this.players.size === 2 ? "playing" : "waiting";
    this.lastActivity = Date.now();
    this.broadcast();
  }
  publicStateFor(viewerNum) {
    const opp = this.players.get(viewerNum === 1 ? 2 : 1);
    const me = this.players.get(viewerNum);
    return {
      type: "duoState", game: "connect4", status: this.status, turn: this.turn, myNum: viewerNum, winner: this.winner,
      board: this.board,
      me: me ? { pseudo: me.pseudo, connected: me.connected } : null,
      opponent: opp ? { pseudo: opp.pseudo, connected: opp.connected } : null,
    };
  }
  broadcast() {
    for (const [num, p] of this.players.entries()) {
      if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(this.publicStateFor(num)));
    }
  }
}

// ================= MODE DUO : PIERRE-FEUILLE-CISEAUX EN LIGNE =================
const RPS_WIN_TARGET = 3; // meilleur des 5 : premier à 3 manches gagnées
function rpsBeats(a, b) { return (a === "rock" && b === "scissors") || (a === "scissors" && b === "paper") || (a === "paper" && b === "rock"); }
class RpsRoom {
  constructor(code) {
    this.code = code;
    this.game = "rps";
    this.players = new Map();
    this.status = "waiting"; // waiting -> playing -> ended
    this.scores = { 1: 0, 2: 0 };
    this.choices = {}; // num -> choix pour la manche en cours
    this.round = 1;
    this.lastResult = null;
    this.winner = null;
    this.lastActivity = Date.now();
  }
  addPlayer(ws, pseudo) {
    if (this.players.size >= 2) return null;
    const num = this.players.size + 1;
    const player = { ws, pseudo: (pseudo || `Joueur ${num}`).slice(0, 16), num, connected: true };
    this.players.set(num, player);
    this.lastActivity = Date.now();
    if (this.players.size === 2) this.status = "playing";
    this.broadcast();
    return player;
  }
  removePlayer(num) {
    const p = this.players.get(num);
    if (!p) return;
    p.connected = false;
    if (this.status === "playing") { this.status = "ended"; this.winner = num === 1 ? 2 : 1; }
    this.broadcast();
  }
  handleChoice(num, choice) {
    if (this.status !== "playing" || !["rock", "paper", "scissors"].includes(choice)) return;
    if (this.choices[num]) return; // déjà choisi cette manche
    this.choices[num] = choice;
    this.lastActivity = Date.now();
    if (this.choices[1] && this.choices[2]) this.resolveRound();
    else this.broadcast();
  }
  resolveRound() {
    const c1 = this.choices[1], c2 = this.choices[2];
    let roundWinner = null;
    if (c1 !== c2) roundWinner = rpsBeats(c1, c2) ? 1 : 2;
    if (roundWinner) this.scores[roundWinner]++;
    this.lastResult = { choices: { ...this.choices }, roundWinner };
    this.choices = {};
    if (this.scores[1] >= RPS_WIN_TARGET || this.scores[2] >= RPS_WIN_TARGET) {
      this.status = "ended";
      this.winner = this.scores[1] > this.scores[2] ? 1 : 2;
    } else {
      this.round++;
    }
    this.broadcast();
  }
  restart() {
    this.scores = { 1: 0, 2: 0 };
    this.choices = {};
    this.round = 1;
    this.lastResult = null;
    this.winner = null;
    this.status = this.players.size === 2 ? "playing" : "waiting";
    this.lastActivity = Date.now();
    this.broadcast();
  }
  publicStateFor(viewerNum) {
    const opp = this.players.get(viewerNum === 1 ? 2 : 1);
    const me = this.players.get(viewerNum);
    return {
      type: "duoState", game: "rps", status: this.status, winner: this.winner, myNum: viewerNum,
      round: this.round, scores: this.scores, winTarget: RPS_WIN_TARGET,
      myChoice: this.choices[viewerNum] || null,
      opponentChose: !!this.choices[viewerNum === 1 ? 2 : 1],
      lastResult: this.lastResult,
      me: me ? { pseudo: me.pseudo, connected: me.connected } : null,
      opponent: opp ? { pseudo: opp.pseudo, connected: opp.connected } : null,
    };
  }
  broadcast() {
    for (const [num, p] of this.players.entries()) {
      if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(this.publicStateFor(num)));
    }
  }
}

// ================= MODE DUO : DAMES (simplifiées) EN LIGNE =================
const CK_SIZE = 8;
function ckInitialBoard() {
  const board = Array.from({ length: CK_SIZE }, () => Array(CK_SIZE).fill(null));
  for (let r = 0; r < 3; r++) for (let c = 0; c < CK_SIZE; c++) if ((r + c) % 2 === 1) board[r][c] = { owner: 1, king: false };
  for (let r = CK_SIZE - 3; r < CK_SIZE; r++) for (let c = 0; c < CK_SIZE; c++) if ((r + c) % 2 === 1) board[r][c] = { owner: 2, king: false };
  return board;
}
function ckInBounds(r, c) { return r >= 0 && r < CK_SIZE && c >= 0 && c < CK_SIZE; }
function ckDirsFor(piece) {
  if (piece.king) return [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  return piece.owner === 1 ? [[1, -1], [1, 1]] : [[-1, -1], [-1, 1]];
}
// ---- Règles des dames (dames « brésiliennes » 8x8) ----
// - prise obligatoire (si on peut prendre, on doit prendre) ;
// - les pions prennent en avant ET en arrière ; les dames sont « volantes » (se déplacent et prennent de loin) ;
// - rafle : après une prise, si la même pièce peut encore prendre, elle doit continuer ;
// - on choisit librement le chemin (pas d'obligation de prendre le maximum) ;
// - les pièces prises restent sur le plateau (et bloquent) jusqu'à la fin de la rafle ;
// - un pion qui finit son tour sur la dernière rangée devient dame.
const CK_DIAGS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
// Prises possibles pour la pièce en (r,c). `taken` = cases déjà prises pendant la rafle (non re-prenables, mais bloquantes).
function ckCaptureOptions(board, num, r, c, taken) {
  const piece = board[r][c];
  const out = [];
  if (!piece) return out;
  const isTaken = (rr, cc) => taken.some(t => t[0] === rr && t[1] === cc);
  for (const [dr, dc] of CK_DIAGS) {
    if (piece.king) {
      let rr = r + dr, cc = c + dc;
      while (ckInBounds(rr, cc) && !board[rr][cc]) { rr += dr; cc += dc; }
      if (!ckInBounds(rr, cc)) continue;
      const victim = board[rr][cc];
      if (victim.owner === num || isTaken(rr, cc)) continue;
      let lr = rr + dr, lc = cc + dc;
      while (ckInBounds(lr, lc) && !board[lr][lc]) { out.push({ tr: lr, tc: lc, cr: rr, cc: cc }); lr += dr; lc += dc; }
    } else {
      const mr = r + dr, mc = c + dc, lr = r + 2 * dr, lc = c + 2 * dc;
      if (!ckInBounds(lr, lc) || !board[mr][mc] || board[lr][lc]) continue;
      if (board[mr][mc].owner === num || isTaken(mr, mc)) continue;
      out.push({ tr: lr, tc: lc, cr: mr, cc: mc });
    }
  }
  return out;
}
// Déplacements simples (sans prise) de la pièce en (r,c).
function ckSimpleMoves(board, num, r, c) {
  const piece = board[r][c];
  const out = [];
  if (!piece) return out;
  if (piece.king) {
    for (const [dr, dc] of CK_DIAGS) {
      let rr = r + dr, cc = c + dc;
      while (ckInBounds(rr, cc) && !board[rr][cc]) { out.push({ tr: rr, tc: cc }); rr += dr; cc += dc; }
    }
  } else {
    const fwd = num === 1 ? 1 : -1;
    for (const dc of [-1, 1]) {
      const rr = r + fwd, cc = c + dc;
      if (ckInBounds(rr, cc) && !board[rr][cc]) out.push({ tr: rr, tc: cc });
    }
  }
  return out;
}
// Liste complète des coups légaux {fr,fc,tr,tc,capture} pour `num`, en tenant compte de la prise obligatoire et de la rafle en cours.
function ckLegalMoves(board, num, chain) {
  const moves = [];
  if (chain) {
    for (const o of ckCaptureOptions(board, num, chain.r, chain.c, chain.taken)) moves.push({ fr: chain.r, fc: chain.c, tr: o.tr, tc: o.tc, capture: true });
    return moves;
  }
  for (let r = 0; r < CK_SIZE; r++) for (let c = 0; c < CK_SIZE; c++) {
    const p = board[r][c];
    if (!p || p.owner !== num) continue;
    for (const o of ckCaptureOptions(board, num, r, c, [])) moves.push({ fr: r, fc: c, tr: o.tr, tc: o.tc, capture: true });
  }
  if (moves.length) return moves; // prise obligatoire
  for (let r = 0; r < CK_SIZE; r++) for (let c = 0; c < CK_SIZE; c++) {
    const p = board[r][c];
    if (!p || p.owner !== num) continue;
    for (const m of ckSimpleMoves(board, num, r, c)) moves.push({ fr: r, fc: c, tr: m.tr, tc: m.tc, capture: false });
  }
  return moves;
}
class CheckersRoom {
  constructor(code) {
    this.code = code;
    this.game = "checkers";
    this.players = new Map();
    this.status = "waiting"; // waiting -> playing -> ended
    this.board = ckInitialBoard();
    this.turn = 1;
    this.winner = null;
    this.lastActivity = Date.now();
  }
  addPlayer(ws, pseudo) {
    if (this.players.size >= 2) return null;
    const num = this.players.size + 1;
    const player = { ws, pseudo: (pseudo || `Joueur ${num}`).slice(0, 16), num, connected: true };
    this.players.set(num, player);
    this.lastActivity = Date.now();
    if (this.players.size === 2) this.status = "playing";
    this.broadcast();
    return player;
  }
  removePlayer(num) {
    const p = this.players.get(num);
    if (!p) return;
    p.connected = false;
    if (this.status === "playing") { this.status = "ended"; this.winner = num === 1 ? 2 : 1; }
    this.broadcast();
  }
  handleMove(num, fr, fc, tr, tc) {
    if (this.status !== "playing" || this.turn !== num) return;
    if (![fr, fc, tr, tc].every(Number.isInteger)) return;
    const legal = ckLegalMoves(this.board, num, this.chain);
    const mv = legal.find(m => m.fr === fr && m.fc === fc && m.tr === tr && m.tc === tc);
    if (!mv) return;
    const piece = this.board[fr][fc];
    this.lastActivity = Date.now();
    this.moveSeq = (this.moveSeq || 0) + 1;
    this.board[tr][tc] = piece;
    this.board[fr][fc] = null;
    if (mv.capture) {
      // trouve la pièce prise sur la diagonale parcourue
      const dr = Math.sign(tr - fr), dc = Math.sign(tc - fc);
      let rr = fr + dr, cc = fc + dc, victim = null;
      while (rr !== tr || cc !== tc) { if (this.board[rr][cc]) victim = [rr, cc]; rr += dr; cc += dc; }
      const taken = (this.chain ? this.chain.taken : []).concat([victim]);
      this.board[victim[0]][victim[1]].taken = true;
      this.lastMove = { fr, fc, tr, tc, capture: true, seq: this.moveSeq };
      if (ckCaptureOptions(this.board, num, tr, tc, taken).length) {
        this.chain = { r: tr, c: tc, taken }; // la rafle continue : même joueur, même pièce
        this.broadcast();
        return;
      }
      for (const [vr, vc] of taken) this.board[vr][vc] = null;
    } else {
      this.lastMove = { fr, fc, tr, tc, capture: false, seq: this.moveSeq };
    }
    this.chain = null;
    if ((piece.owner === 1 && tr === CK_SIZE - 1) || (piece.owner === 2 && tr === 0)) piece.king = true;
    const oppNum = num === 1 ? 2 : 1;
    const oppHasPieces = this.board.some(row => row.some(cell => cell && cell.owner === oppNum));
    if (!oppHasPieces || !this.hasAnyLegalMove(oppNum)) { this.status = "ended"; this.winner = num; this.broadcast(); return; }
    this.turn = oppNum;
    this.broadcast();
  }
  hasAnyLegalMove(num) { return ckLegalMoves(this.board, num, null).length > 0; }
  restart() {
    this.board = ckInitialBoard();
    this.turn = 1;
    this.winner = null;
    this.chain = null;
    this.lastMove = null;
    this.status = this.players.size === 2 ? "playing" : "waiting";
    this.lastActivity = Date.now();
    this.broadcast();
  }
  publicStateFor(viewerNum) {
    const opp = this.players.get(viewerNum === 1 ? 2 : 1);
    const me = this.players.get(viewerNum);
    return {
      type: "duoState", game: "checkers", status: this.status, turn: this.turn, myNum: viewerNum, winner: this.winner,
      board: this.board, lastMove: this.lastMove || null,
      chain: this.chain ? { r: this.chain.r, c: this.chain.c } : null,
      legal: (this.status === "playing" && this.turn === viewerNum) ? ckLegalMoves(this.board, viewerNum, this.chain) : [],
      me: me ? { pseudo: me.pseudo, connected: me.connected } : null,
      opponent: opp ? { pseudo: opp.pseudo, connected: opp.connected } : null,
    };
  }
  broadcast() {
    for (const [num, p] of this.players.entries()) {
      if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(this.publicStateFor(num)));
    }
  }
}


// ================= MODE DUO : NOUVEAUX JEUX (Memory, Tir à la corde, Morpion 5, Tir aux pigeons) =================
function shuffleArr(a) { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; }
class SimpleDuoRoom {
  constructor(code, game) {
    this.code = code;
    this.game = game;
    this.players = new Map();
    this.status = "waiting";
    this.turn = 1;
    this.winner = null;
    this.timer = null;
    this.lastActivity = Date.now();
  }
  addPlayer(ws, pseudo) {
    if (this.players.size >= 2) return null;
    const num = this.players.size + 1;
    const player = { ws, pseudo: (pseudo || `Joueur ${num}`).slice(0, 16), num, connected: true };
    this.players.set(num, player);
    this.lastActivity = Date.now();
    if (this.players.size === 2) { this.status = "playing"; this.begin(); }
    this.broadcast();
    return player;
  }
  removePlayer(num) {
    const p = this.players.get(num);
    if (!p) return;
    p.connected = false;
    if (this.status === "playing") { this.status = "ended"; this.winner = num === 1 ? 2 : 1; this.stop(); }
    this.broadcast();
  }
  stop() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  begin() {}
  end(winner) { this.stop(); this.status = "ended"; this.winner = winner; this.broadcast(); }
  restart() {
    this.stop();
    this.resetState();
    this.status = this.players.size === 2 ? "playing" : "waiting";
    if (this.status === "playing") this.begin();
    this.lastActivity = Date.now();
    this.broadcast();
  }
  publicStateFor(viewerNum) {
    const opp = this.players.get(viewerNum === 1 ? 2 : 1);
    const me = this.players.get(viewerNum);
    return Object.assign({
      type: "duoState", game: this.game, status: this.status, turn: this.turn, myNum: viewerNum, winner: this.winner,
      me: me ? { pseudo: me.pseudo, connected: me.connected } : null,
      opponent: opp ? { pseudo: opp.pseudo, connected: opp.connected } : null,
    }, this.extraState(viewerNum));
  }
  broadcast() {
    for (const [num, p] of this.players.entries()) {
      if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(this.publicStateFor(num)));
    }
  }
}

// ---- Memory duel ----
const MEM_EMOJIS = ["🍎", "🍌", "🍇", "🍒", "🥝", "🍑", "🍋", "🥥", "🍓", "🍉", "🍍", "🥕"];
class MemoryRoom extends SimpleDuoRoom {
  constructor(code) { super(code, "memory"); this.resetState(); }
  resetState() {
    this.cards = shuffleArr(MEM_EMOJIS.concat(MEM_EMOJIS)).map(s => ({ s, state: "down", owner: null }));
    this.scores = { 1: 0, 2: 0 };
    this.turn = 1; this.winner = null; this.flipped = []; this.lock = false;
  }
  handleAct(num, msg) {
    if (msg.type !== "duoFlip" || this.status !== "playing" || this.turn !== num || this.lock) return;
    const i = msg.i;
    if (!Number.isInteger(i) || !this.cards[i] || this.cards[i].state !== "down") return;
    this.cards[i].state = "up";
    this.flipped.push(i);
    if (this.flipped.length === 2) {
      const [a, b] = this.flipped;
      if (this.cards[a].s === this.cards[b].s) {
        this.cards[a].state = this.cards[b].state = "matched";
        this.cards[a].owner = this.cards[b].owner = num;
        this.scores[num]++;
        this.flipped = [];
        if (this.cards.every(c => c.state === "matched")) {
          this.end(this.scores[1] === this.scores[2] ? null : (this.scores[1] > this.scores[2] ? 1 : 2));
          return;
        }
      } else {
        this.lock = true;
        this.timer = setTimeout(() => {
          this.cards[a].state = "down"; this.cards[b].state = "down";
          this.flipped = []; this.lock = false;
          this.turn = num === 1 ? 2 : 1;
          this.broadcast();
        }, 1100);
      }
    }
    this.broadcast();
  }
  extraState() {
    return { cards: this.cards.map(c => ({ state: c.state, s: c.state === "down" ? null : c.s, owner: c.owner })), scores: this.scores, locked: this.lock };
  }
}

// ---- Tir à la corde (temps réel) ----
const TUG_TARGET = 25, TUG_COUNTDOWN_MS = 3000, TUG_DURATION_MS = 30000;
class TugRoom extends SimpleDuoRoom {
  constructor(code) { super(code, "tug"); this.resetState(); }
  resetState() { this.pos = 0; this.winner = null; this.goAt = 0; this.endAt = 0; }
  begin() {
    this.goAt = Date.now() + TUG_COUNTDOWN_MS;
    this.endAt = this.goAt + TUG_DURATION_MS;
    this.timer = setTimeout(() => { if (this.status === "playing") this.end(this.pos > 0 ? 1 : this.pos < 0 ? 2 : null); }, TUG_COUNTDOWN_MS + TUG_DURATION_MS + 200);
  }
  handleAct(num, msg) {
    if (msg.type !== "duoTap" || this.status !== "playing" || Date.now() < this.goAt) return;
    this.pos += num === 1 ? 1 : -1;
    if (this.pos >= TUG_TARGET) { this.end(1); return; }
    if (this.pos <= -TUG_TARGET) { this.end(2); return; }
    this.broadcast();
  }
  extraState() {
    const now = Date.now();
    return { pos: this.pos, target: TUG_TARGET, countdownMs: Math.max(0, this.goAt - now), timeLeftMs: Math.max(0, this.endAt - now) };
  }
}

// ---- Morpion 5 en ligne (grille 12x12) ----
const GO_SIZE = 12;
class GomokuRoom extends SimpleDuoRoom {
  constructor(code) { super(code, "gomoku"); this.resetState(); }
  resetState() {
    this.board = Array.from({ length: GO_SIZE }, () => Array(GO_SIZE).fill(null));
    this.turn = 1; this.winner = null; this.winLine = []; this.lastMove = null;
  }
  line(r, c, num) {
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const cells = [[r, c]];
      for (let s = 1; s < 5; s++) { const rr = r + dr * s, cc = c + dc * s; if (rr < 0 || rr >= GO_SIZE || cc < 0 || cc >= GO_SIZE || this.board[rr][cc] !== num) break; cells.push([rr, cc]); }
      for (let s = 1; s < 5; s++) { const rr = r - dr * s, cc = c - dc * s; if (rr < 0 || rr >= GO_SIZE || cc < 0 || cc >= GO_SIZE || this.board[rr][cc] !== num) break; cells.push([rr, cc]); }
      if (cells.length >= 5) return cells;
    }
    return null;
  }
  handleAct(num, msg) {
    if (msg.type !== "duoPlace" || this.status !== "playing" || this.turn !== num) return;
    const { r, c } = msg;
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= GO_SIZE || c < 0 || c >= GO_SIZE || this.board[r][c]) return;
    this.board[r][c] = num;
    this.lastMove = { r, c };
    const line = this.line(r, c, num);
    if (line) { this.winLine = line; this.end(num); return; }
    if (this.board.every(row => row.every(x => x))) { this.end(null); return; }
    this.turn = num === 1 ? 2 : 1;
    this.broadcast();
  }
  extraState() { return { board: this.board, winLine: this.winLine, lastMove: this.lastMove, size: GO_SIZE }; }
}

// ---- Tir aux pigeons (temps réel) ----
const PG_TOTAL = 15, PG_COUNTDOWN_MS = 3000, PG_BIRDS = ["🐦", "🕊️", "🦆", "🦅"];
class PigeonsRoom extends SimpleDuoRoom {
  constructor(code) { super(code, "pigeons"); this.resetState(); }
  resetState() { this.scores = { 1: 0, 2: 0 }; this.round = 0; this.target = null; this.nextId = 1; this.lastHit = null; this.winner = null; this.goAt = 0; }
  begin() { this.goAt = Date.now() + PG_COUNTDOWN_MS; this.timer = setTimeout(() => this.spawn(), PG_COUNTDOWN_MS); }
  spawn() {
    if (this.status !== "playing") return;
    if (this.round >= PG_TOTAL) { this.end(this.scores[1] === this.scores[2] ? null : (this.scores[1] > this.scores[2] ? 1 : 2)); return; }
    this.round++;
    this.target = { id: this.nextId++, x: 10 + Math.random() * 80, y: 12 + Math.random() * 76, emoji: PG_BIRDS[Math.floor(Math.random() * PG_BIRDS.length)] };
    this.broadcast();
    const id = this.target.id;
    this.timer = setTimeout(() => {
      if (this.status !== "playing" || !this.target || this.target.id !== id) return;
      this.target = null; this.lastHit = { by: 0, id };
      this.broadcast();
      this.timer = setTimeout(() => this.spawn(), 500);
    }, 1800);
  }
  handleAct(num, msg) {
    if (msg.type !== "duoShoot" || this.status !== "playing" || !this.target || this.target.id !== msg.id) return;
    this.scores[num]++;
    this.lastHit = { by: num, id: this.target.id, x: this.target.x, y: this.target.y };
    this.target = null;
    this.stop();
    this.broadcast();
    this.timer = setTimeout(() => this.spawn(), 450 + Math.random() * 700);
  }
  extraState() { return { scores: this.scores, round: this.round, total: PG_TOTAL, target: this.target, lastHit: this.lastHit, countdownMs: Math.max(0, this.goAt - Date.now()) }; }
}


// ---- Bataille de mines (Duo) : traverse le terrain miné de l'adversaire, premier arrivé gagne ----
const MN_SIZE = 6, MN_MINES = 8;
class MinesRoom extends SimpleDuoRoom {
  constructor(code) { super(code, "mines"); this.resetState(); }
  resetState() {
    this.phase = "placing"; this.turn = 1; this.winner = null; this.evN = 0; this.lastEvent = null;
    this.pl = {};
    for (const n of [1, 2]) this.pl[n] = { mines: [], ready: false, pawn: { r: MN_SIZE - 1, c: 2 }, revealed: [], visited: [] };
  }
  has(list, r, c) { return list.some(p => p[0] === r && p[1] === c); }
  handleAct(num, msg) {
    if (this.status !== "playing") return;
    if (msg.type === "duoMines" && this.phase === "placing" && !this.pl[num].ready) {
      const m = msg.mines;
      if (!Array.isArray(m) || m.length !== MN_MINES) return;
      const seen = [];
      for (const p of m) {
        if (!Array.isArray(p) || !Number.isInteger(p[0]) || !Number.isInteger(p[1])) return;
        if (p[0] < 1 || p[0] > MN_SIZE - 2 || p[1] < 0 || p[1] >= MN_SIZE || this.has(seen, p[0], p[1])) return;
        seen.push([p[0], p[1]]);
      }
      this.pl[num].mines = seen; this.pl[num].ready = true;
      if (this.pl[1].ready && this.pl[2].ready) { this.phase = "racing"; this.turn = 1; }
      this.broadcast();
    } else if (msg.type === "duoStep" && this.phase === "racing" && this.turn === num) {
      const d = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] }[msg.dir];
      if (!d) return;
      const me = this.pl[num], opp = this.pl[num === 1 ? 2 : 1];
      const r = me.pawn.r + d[0], c = me.pawn.c + d[1];
      if (r < 0 || r >= MN_SIZE || c < 0 || c >= MN_SIZE) return;
      if (this.has(opp.mines, r, c)) {
        if (!this.has(me.revealed, r, c)) me.revealed.push([r, c]);
        me.pawn = { r: MN_SIZE - 1, c: 2 };
        this.lastEvent = { type: "boom", by: num, r, c, n: ++this.evN };
      } else {
        me.pawn = { r, c };
        if (!this.has(me.visited, r, c)) me.visited.push([r, c]);
        this.lastEvent = { type: "step", by: num, r, c, n: ++this.evN };
        if (r === 0) { this.end(num); return; }
      }
      this.turn = num === 1 ? 2 : 1;
      this.broadcast();
    }
  }
  extraState(v) {
    const o = v === 1 ? 2 : 1, me = this.pl[v], op = this.pl[o];
    return { size: MN_SIZE, phase: this.phase, mineCount: MN_MINES, lastEvent: this.lastEvent,
      myReady: me.ready, oppReady: op.ready,
      my: { mines: me.mines, pawn: me.pawn, revealed: me.revealed, visited: me.visited },
      opp: { pawn: op.pawn, revealed: op.revealed } };
  }
}

// ---- Plus ou moins (Duo) : devine le nombre secret (1-100) de l'adversaire ----
class PlusMoinsRoom extends SimpleDuoRoom {
  constructor(code) { super(code, "plusmoins"); this.resetState(); }
  resetState() {
    this.phase = "placing"; this.turn = 1; this.winner = null;
    this.secret = { 1: null, 2: null }; this.guesses = { 1: [], 2: [] };
  }
  handleAct(num, msg) {
    if (this.status !== "playing") return;
    if (msg.type === "duoSecret" && this.phase === "placing" && this.secret[num] === null) {
      const n = msg.n;
      if (!Number.isInteger(n) || n < 1 || n > 100) return;
      this.secret[num] = n;
      if (this.secret[1] !== null && this.secret[2] !== null) { this.phase = "racing"; this.turn = 1; }
      this.broadcast();
    } else if (msg.type === "duoGuess" && this.phase === "racing" && this.turn === num) {
      const n = msg.n;
      if (!Number.isInteger(n) || n < 1 || n > 100) return;
      const target = this.secret[num === 1 ? 2 : 1];
      const res = n === target ? "ok" : (n < target ? "plus" : "moins");
      this.guesses[num].push({ n, res });
      if (res === "ok") { this.end(num); return; }
      this.turn = num === 1 ? 2 : 1;
      this.broadcast();
    }
  }
  extraState(v) {
    const o = v === 1 ? 2 : 1;
    return { phase: this.phase, myReady: this.secret[v] !== null, oppReady: this.secret[o] !== null,
      mySecret: this.secret[v], myGuesses: this.guesses[v], oppGuesses: this.guesses[o],
      oppSecret: this.status === "ended" ? this.secret[o] : null };
  }
}

// ---- Registre des rooms en mémoire ----
const rooms = new Map();
const duoRooms = new Map();
const DUO_GAMES = ["battleship", "connect4", "rps", "checkers", "memory", "tug", "gomoku", "pigeons", "mines", "plusmoins"];
function getOrCreateDuoRoom(code, game) {
  code = code.toUpperCase();
  let room = duoRooms.get(code);
  if (!room) {
    const g = DUO_GAMES.includes(game) ? game : "battleship";
    room = createDuoRoomOfGame(code, g);
    duoRooms.set(code, room);
  }
  return room;
}
function createDuoRoomOfGame(code, g) {
  if (g === "connect4") return new Connect4Room(code);
  if (g === "rps") return new RpsRoom(code);
  if (g === "checkers") return new CheckersRoom(code);
  if (g === "memory") return new MemoryRoom(code);
  if (g === "tug") return new TugRoom(code);
  if (g === "gomoku") return new GomokuRoom(code);
  if (g === "pigeons") return new PigeonsRoom(code);
  if (g === "mines") return new MinesRoom(code);
  if (g === "plusmoins") return new PlusMoinsRoom(code);
  return new DuoRoom(code);
}
// Change de mini-jeu entre deux parties : la salle est recréée pour le nouveau jeu avec les deux mêmes joueurs.
function switchDuoGame(oldRoom, game) {
  if (!DUO_GAMES.includes(game) || game === oldRoom.game || oldRoom.status !== "ended") return oldRoom;
  const p1 = oldRoom.players.get(1), p2 = oldRoom.players.get(2);
  if (!p1 || !p2 || p1.connected === false || p2.connected === false) return oldRoom;
  if (oldRoom.stop) oldRoom.stop();
  const room = createDuoRoomOfGame(oldRoom.code, game);
  room.isPublic = oldRoom.isPublic;
  duoRooms.set(oldRoom.code, room);
  for (const p of [p1, p2]) {
    const np = room.addPlayer(p.ws, p.pseudo);
    try { p.ws.send(JSON.stringify({ type: "duoWelcome", num: np.num, code: room.code, game: room.game })); } catch (e) { /* ignore */ }
  }
  room.broadcast();
  return room;
}
function getOrCreateRoom(code) {
  code = code.toUpperCase();
  let room = rooms.get(code);
  if (!room) { room = new Room(code); rooms.set(code, room); }
  room.lastActivity = Date.now();
  return room;
}

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const hasPlayers = Object.keys(room.players).length > 0;
    if (!hasPlayers && now - room.lastActivity > ROOM_IDLE_CLEANUP_MS) {
      if (room.timer) clearTimeout(room.timer);
      if (room.hillTimer) clearInterval(room.hillTimer);
      if (room.secondTimer) clearInterval(room.secondTimer);
      room.pendingAttacks.forEach(h => clearTimeout(h));
      rooms.delete(code);
    }
  }
}, 1000 * 60 * 10);
cleanupInterval.unref();

const duoCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of duoRooms.entries()) {
    const connectedCount = Array.from(room.players.values()).filter(p => p.connected !== false).length;
    if (connectedCount === 0 && now - room.lastActivity > DUO_IDLE_CLEANUP_MS) {
      if (room.stop) room.stop();
      duoRooms.delete(code);
    }
  }
}, 1000 * 60 * 10);
duoCleanupInterval.unref();


// ================= MODE MULTI : JEUX DE SOCIÉTÉ À PLUSIEURS (2 à 8 joueurs) =================
const PARTY_MAX = 8;
const PARTY_GAMES = ["simon", "potato", "stop10", "memory", "taps", "vote"];
const partyRooms = new Map();

// ---- Simon : chacun son tour rejoue toute la séquence puis ajoute une couleur ----
class SimonParty {
  constructor(room, ids) {
    this.room = room; this.game = "simon";
    this.alive = ids.slice(); this.eliminated = [];
    this.seq = []; this.turnIdx = 0; this.phase = "show"; this.input = 0; this.showId = 0;
    this.lastTap = null; this.lastEvent = null; this.timer = null; this.tapN = 0; this.evN = 0;
  }
  cur() { return this.alive[this.turnIdx % this.alive.length]; }
  start() { this.beginTurn(); }
  stop() { clearTimeout(this.timer); clearTimeout(this.tTimer); }
  beginTurn() {
    this.stop();
    this.input = 0;
    if (this.seq.length === 0) { this.phase = "input"; this.armTimeout(); }
    else {
      this.phase = "show"; this.showId++;
      this.timer = setTimeout(() => { this.phase = "input"; this.input = 0; this.armTimeout(); this.room.broadcast(); }, this.seq.length * 650 + 900);
    }
    this.room.broadcast();
  }
  armTimeout() { clearTimeout(this.tTimer); this.tTimer = setTimeout(() => this.fail(this.cur()), 12000); }
  act(id, msg) {
    if (msg.type !== "simonTap" || this.phase !== "input" || id !== this.cur()) return;
    const pad = msg.pad;
    if (!Number.isInteger(pad) || pad < 0 || pad > 3) return;
    this.tapN++;
    this.lastTap = { id, pad, n: this.tapN };
    if (this.input < this.seq.length) {
      if (pad !== this.seq[this.input]) { this.fail(id); return; }
      this.input++;
      this.armTimeout();
      this.room.broadcast();
    } else {
      this.seq.push(pad);
      this.lastEvent = { type: "added", id, n: ++this.evN };
      this.turnIdx = (this.alive.indexOf(id) + 1) % this.alive.length;
      this.beginTurn();
    }
  }
  fail(id) {
    const idx = this.alive.indexOf(id);
    if (idx < 0) return;
    this.alive.splice(idx, 1); this.eliminated.push(id);
    this.lastEvent = { type: "out", id, n: ++this.evN };
    if (this.alive.length <= 1) { this.stop(); this.room.finish(this.alive[0] || null); return; }
    this.turnIdx = idx % this.alive.length;
    this.beginTurn();
  }
  onLeave(id) {
    if (!this.alive.includes(id)) return;
    if (id === this.cur()) { this.fail(id); return; }
    const idx = this.alive.indexOf(id), curId = this.cur();
    this.alive.splice(idx, 1); this.eliminated.push(id);
    this.turnIdx = this.alive.indexOf(curId);
    if (this.alive.length <= 1) { this.stop(); this.room.finish(this.alive[0] || null); return; }
    this.room.broadcast();
  }
  state() {
    return { game: "simon", phase: this.phase, turnId: this.cur(), seqLen: this.seq.length, seq: this.phase === "show" ? this.seq : null,
      showId: this.showId, input: this.input, alive: this.alive, eliminated: this.eliminated, lastTap: this.lastTap, lastEvent: this.lastEvent };
  }
}

// ---- Patate chaude : la patate explose entre les mains de quelqu'un ----
class PotatoParty {
  constructor(room, ids) {
    this.room = room; this.game = "potato";
    this.alive = ids.slice(); this.eliminated = [];
    this.holder = null; this.passes = 0; this.lastPass = null; this.lastEvent = null; this.timer = null; this.boomN = 0;
  }
  start() { this.holder = this.alive[Math.floor(Math.random() * this.alive.length)]; this.arm(); this.room.broadcast(); }
  stop() { clearTimeout(this.timer); }
  arm() { clearTimeout(this.timer); this.timer = setTimeout(() => this.boom(), 6000 + Math.random() * 12000); }
  act(id, msg) {
    if (msg.type !== "potatoPass" || id !== this.holder) return;
    const to = msg.to;
    if (!this.alive.includes(to) || to === id) return;
    this.holder = to; this.passes++;
    this.lastPass = { from: id, to, n: this.passes };
    this.room.broadcast();
  }
  boom() {
    const out = this.holder;
    this.removeAlive(out);
    this.boomN++;
    this.lastEvent = { type: "boom", id: out, n: this.boomN };
    if (this.alive.length <= 1) { this.stop(); this.room.finish(this.alive[0] || null); return; }
    this.holder = this.alive[Math.floor(Math.random() * this.alive.length)];
    this.arm();
    this.room.broadcast();
  }
  removeAlive(id) { const i = this.alive.indexOf(id); if (i >= 0) { this.alive.splice(i, 1); this.eliminated.push(id); } }
  onLeave(id) {
    if (!this.alive.includes(id)) return;
    if (id === this.holder) { this.boom(); return; }
    this.removeAlive(id);
    if (this.alive.length <= 1) { this.stop(); this.room.finish(this.alive[0] || null); return; }
    this.room.broadcast();
  }
  state() { return { game: "potato", holderId: this.holder, alive: this.alive, eliminated: this.eliminated, lastPass: this.lastPass, lastEvent: this.lastEvent }; }
}


// ---- Stop à 10 : appuie pile à 10,00 s sans voir le compteur (3 manches) ----
class StopParty {
  constructor(room, ids) {
    this.room = room; this.game = "stop10";
    this.ids = ids.slice(); this.left = [];
    this.round = 0; this.rounds = 3;
    this.totals = {}; ids.forEach(i => { this.totals[i] = 0; });
    this.phase = "countdown"; this.tapped = {}; this.errors = {};
    this.startAt = 0; this.countdownEnds = 0; this.timer = null; this.ranking = null;
  }
  active() { return this.ids.filter(i => !this.left.includes(i)); }
  start() { this.nextRound(); }
  stop() { clearTimeout(this.timer); }
  nextRound() {
    this.round++; this.phase = "countdown"; this.tapped = {}; this.errors = {};
    this.countdownEnds = Date.now() + 3000;
    this.room.broadcast();
    this.timer = setTimeout(() => {
      this.phase = "running"; this.startAt = Date.now();
      this.room.broadcast();
      this.timer = setTimeout(() => this.endRound(), 13000);
    }, 3000);
  }
  act(id, msg) {
    if (msg.type !== "stopTap" || this.phase !== "running" || this.tapped[id] || this.left.includes(id) || !this.ids.includes(id)) return;
    this.tapped[id] = true;
    this.errors[id] = Math.abs(Date.now() - this.startAt - 10000);
    if (this.active().every(i => this.tapped[i])) { clearTimeout(this.timer); this.endRound(); return; }
    this.room.broadcast();
  }
  endRound() {
    for (const id of this.ids) {
      if (this.errors[id] === undefined) this.errors[id] = 5000;
      this.totals[id] += this.errors[id];
    }
    this.phase = "results";
    this.room.broadcast();
    this.timer = setTimeout(() => { if (this.round >= this.rounds) this.finishAll(); else this.nextRound(); }, 4500);
  }
  finishAll() {
    const act = this.active();
    this.ranking = this.ids.slice().sort((a, b) => this.totals[a] - this.totals[b]).map(id => ({ id, score: this.totals[id], left: this.left.includes(id) }));
    const best = this.ranking.find(r => !r.left);
    this.room.finish(best ? best.id : null);
  }
  onLeave(id) {
    if (!this.ids.includes(id) || this.left.includes(id)) return;
    this.left.push(id);
    const act = this.active();
    if (act.length <= 1) { this.stop(); this.finishAll(); return; }
    if (this.phase === "running" && act.every(i => this.tapped[i])) { clearTimeout(this.timer); this.endRound(); return; }
    this.room.broadcast();
  }
  state() {
    const now = Date.now();
    return { game: "stop10", phase: this.phase, round: this.round, rounds: this.rounds,
      elapsedMs: this.phase === "running" ? now - this.startAt : 0, countdownMs: this.phase === "countdown" ? Math.max(0, this.countdownEnds - now) : 0,
      tapped: this.tapped, errors: this.phase === "results" || this.ranking ? this.errors : null, totals: this.phase === "results" || this.ranking ? this.totals : null,
      left: this.left, ranking: this.ranking };
  }
}

// ---- Memory à plusieurs : même plateau, chacun son tour ----
const PARTY_MEM_EMOJIS = MEM_EMOJIS.concat(["🍐", "🥑", "🍔"]);
class MemoryParty {
  constructor(room, ids) {
    this.room = room; this.game = "memory";
    this.ids = ids.slice(); this.left = [];
    this.cards = shuffleArr(PARTY_MEM_EMOJIS.concat(PARTY_MEM_EMOJIS)).map(s => ({ s, state: "down", owner: null }));
    this.scores = {}; ids.forEach(i => { this.scores[i] = 0; });
    this.turnIdx = 0; this.flipped = []; this.lock = false; this.timer = null; this.ranking = null;
  }
  active() { return this.ids.filter(i => !this.left.includes(i)); }
  cur() { const a = this.active(); return a[this.turnIdx % a.length]; }
  start() { this.room.broadcast(); }
  stop() { clearTimeout(this.timer); }
  nextTurn() { this.flipped = []; this.lock = false; const a = this.active(); const i = a.indexOf(this.cur()); this.turnIdx = (i + 1) % a.length; }
  act(id, msg) {
    if (msg.type !== "memFlip" || id !== this.cur() || this.lock) return;
    const i = msg.i;
    if (!Number.isInteger(i) || !this.cards[i] || this.cards[i].state !== "down") return;
    this.cards[i].state = "up"; this.flipped.push(i);
    if (this.flipped.length === 2) {
      const [a, b] = this.flipped;
      if (this.cards[a].s === this.cards[b].s) {
        this.cards[a].state = this.cards[b].state = "matched";
        this.cards[a].owner = this.cards[b].owner = id;
        this.scores[id]++; this.flipped = [];
        if (this.cards.every(c => c.state === "matched")) { this.finishAll(); return; }
      } else {
        this.lock = true;
        this.timer = setTimeout(() => {
          this.cards[a].state = "down"; this.cards[b].state = "down";
          this.nextTurn(); this.room.broadcast();
        }, 1200);
      }
    }
    this.room.broadcast();
  }
  finishAll() {
    this.ranking = this.ids.slice().sort((a, b) => this.scores[b] - this.scores[a]).map(id => ({ id, score: this.scores[id], left: this.left.includes(id) }));
    const tie = this.ranking.length > 1 && this.ranking[0].score === this.ranking[1].score;
    this.room.finish(tie ? null : this.ranking[0].id);
  }
  onLeave(id) {
    if (!this.ids.includes(id) || this.left.includes(id)) return;
    const wasCur = this.cur() === id;
    this.left.push(id);
    const act = this.active();
    if (act.length <= 1) { this.stop(); this.finishAll(); return; }
    if (wasCur) {
      clearTimeout(this.timer);
      this.flipped.forEach(i => { if (this.cards[i].state === "up") this.cards[i].state = "down"; });
      this.flipped = []; this.lock = false;
      this.turnIdx = this.turnIdx % act.length;
    } else {
      this.turnIdx = this.active().indexOf(this.cur());
      if (this.turnIdx < 0) this.turnIdx = 0;
    }
    this.room.broadcast();
  }
  state() {
    return { game: "memory", turnId: this.cur(), locked: this.lock, scores: this.scores, left: this.left, ranking: this.ranking,
      cards: this.cards.map(c => ({ state: c.state, s: c.state === "down" ? null : c.s, owner: c.owner })) };
  }
}

// ---- Course de taps : 10 secondes pour taper le plus possible ----
class TapsParty {
  constructor(room, ids) {
    this.room = room; this.game = "taps";
    this.ids = ids.slice(); this.left = [];
    this.counts = {}; this.last = {}; ids.forEach(i => { this.counts[i] = 0; this.last[i] = 0; });
    this.phase = "countdown"; this.goAt = 0; this.endAt = 0; this.timer = null; this.tick = null; this.dirty = false; this.ranking = null;
  }
  start() {
    this.goAt = Date.now() + 3000; this.endAt = this.goAt + 10000;
    this.room.broadcast();
    this.timer = setTimeout(() => {
      this.phase = "running";
      this.room.broadcast();
      this.tick = setInterval(() => { if (this.dirty) { this.dirty = false; this.room.broadcast(); } }, 150);
      this.timer = setTimeout(() => this.finishAll(), 10000);
    }, 3000);
  }
  stop() { clearTimeout(this.timer); clearInterval(this.tick); }
  act(id, msg) {
    if (msg.type !== "tapTap" || this.phase !== "running" || !this.ids.includes(id) || this.left.includes(id)) return;
    const now = Date.now();
    if (now - this.last[id] < 35) return; // anti-spam : ~28 taps/s max
    this.last[id] = now; this.counts[id]++; this.dirty = true;
  }
  finishAll() {
    this.stop(); this.phase = "ended";
    this.ranking = this.ids.slice().sort((a, b) => this.counts[b] - this.counts[a]).map(id => ({ id, score: this.counts[id], left: this.left.includes(id) }));
    const tie = this.ranking.length > 1 && this.ranking[0].score === this.ranking[1].score;
    this.room.finish(tie ? null : this.ranking[0].id);
  }
  onLeave(id) {
    if (!this.ids.includes(id) || this.left.includes(id)) return;
    this.left.push(id);
    if (this.ids.filter(i => !this.left.includes(i)).length <= 1) { this.finishAll(); return; }
    this.room.broadcast();
  }
  state() {
    const now = Date.now();
    return { game: "taps", phase: this.phase, countdownMs: this.phase === "countdown" ? Math.max(0, this.goAt - now) : 0,
      timeLeftMs: this.phase === "running" ? Math.max(0, this.endAt - now) : (this.phase === "ended" ? 0 : 10000),
      counts: this.counts, left: this.left, ranking: this.ranking };
  }
}


// ---- Vote du plus… : questions fun, chacun vote pour un joueur ----
const VOTE_QUESTIONS = [
  "Qui est le plus susceptible d'arriver en retard à son propre mariage ?",
  "Qui est le plus susceptible de survivre dans la jungle ?",
  "Qui est le plus susceptible de devenir célèbre ?",
  "Qui est le plus susceptible de s'endormir pendant un film ?",
  "Qui est le plus susceptible de perdre ses clés ?",
  "Qui est le plus susceptible de gagner au loto et tout dépenser en une semaine ?",
  "Qui est le plus susceptible d'oublier un anniversaire ?",
  "Qui est le plus susceptible de rire au pire moment ?",
  "Qui est le plus susceptible de pleurer devant un dessin animé ?",
  "Qui est le plus susceptible de parler tout seul ?",
  "Qui est le plus susceptible de tout planifier dans les moindres détails ?",
  "Qui est le plus susceptible de se perdre avec un GPS ?",
  "Qui est le plus susceptible de manger le dernier morceau de gâteau sans demander ?",
  "Qui est le plus susceptible de devenir milliardaire ?",
  "Qui est le plus susceptible de partir vivre à l'étranger sur un coup de tête ?",
  "Qui est le plus susceptible de gagner une partie d'échecs ?",
  "Qui est le plus susceptible de rester calme en cas de catastrophe ?",
  "Qui est le plus susceptible de paniquer pour rien ?",
  "Qui est le plus susceptible de dire la vérité même si ça fait mal ?",
  "Qui est le plus susceptible de mentir avec un grand sourire ?",
  "Qui est le plus susceptible de rater son train ?",
  "Qui est le plus susceptible d'adopter 10 chats ?",
  "Qui est le plus susceptible de commencer un régime et d'abandonner le lendemain ?",
  "Qui est le plus susceptible de chanter sous la douche à tue-tête ?",
  "Qui est le plus susceptible de devenir président(e) ?",
  "Qui est le plus susceptible d'inventer quelque chose d'utile ?",
  "Qui est le plus susceptible de se faire un tatouage sur un coup de tête ?",
  "Qui est le plus susceptible de rester au lit toute la journée ?",
  "Qui est le plus susceptible de tricher aux jeux de société ?",
  "Qui est le plus susceptible de faire le tour du monde ?",
  "Qui est le plus susceptible de rater un examen à cause d'un oubli ?",
  "Qui est le plus susceptible de répondre « je suis presque arrivé » alors qu'il n'est pas parti ?",
  "Qui est le plus susceptible de tomber amoureux en une semaine ?",
  "Qui est le plus susceptible de faire un discours improvisé de 20 minutes ?",
  "Qui est le plus susceptible de casser son téléphone ?",
  "Qui est le plus susceptible de gagner un concours de danse ?",
  "Qui est le plus susceptible de devenir un grand chef cuisinier ?",
  "Qui est le plus susceptible de se déguiser sans raison ?",
  "Qui est le plus susceptible de lire tout un livre en une nuit ?",
  "Qui est le plus susceptible d'avoir peur d'une petite araignée ?",
  "Qui est le plus susceptible de répondre à un message trois jours plus tard ?",
  "Qui est le plus susceptible de gagner à un jeu vidéo sans s'entraîner ?",
  "Qui est le plus susceptible de faire un câlin à un inconnu ?",
  "Qui est le plus susceptible de dépenser tout son argent en une soirée ?",
  "Qui est le plus susceptible de devenir une star de cinéma ?",
  "Qui est le plus susceptible de se réveiller avant le réveil ?",
  "Qui est le plus susceptible de dire « j'ai tout compris » sans avoir rien compris ?",
];
const VOTE_ROUNDS = 8, VOTE_TIME_MS = 25000, VOTE_RESULT_MS = 6000;
class VoteParty {
  constructor(room, ids) {
    this.room = room; this.game = "vote";
    this.ids = ids.slice(); this.left = [];
    this.totals = {}; ids.forEach(i => { this.totals[i] = 0; });
    this.questions = shuffleArr(VOTE_QUESTIONS).slice(0, VOTE_ROUNDS);
    this.round = 0; this.phase = "voting"; this.votes = {}; this.voteEnds = 0; this.timer = null; this.ranking = null; this.roundCounts = null;
  }
  active() { return this.ids.filter(i => !this.left.includes(i)); }
  start() { this.nextRound(); }
  stop() { clearTimeout(this.timer); }
  nextRound() {
    this.round++; this.phase = "voting"; this.votes = {}; this.roundCounts = null;
    this.voteEnds = Date.now() + VOTE_TIME_MS;
    this.room.broadcast();
    this.timer = setTimeout(() => this.endRound(), VOTE_TIME_MS);
  }
  act(id, msg) {
    if (msg.type !== "voteFor" || this.phase !== "voting" || this.left.includes(id) || !this.ids.includes(id) || this.votes[id] !== undefined) return;
    const to = msg.to;
    if (!this.ids.includes(to) || to === id || this.left.includes(to)) return;
    this.votes[id] = to;
    if (this.active().every(i => this.votes[i] !== undefined)) { clearTimeout(this.timer); this.endRound(); return; }
    this.room.broadcast();
  }
  endRound() {
    this.roundCounts = {};
    this.ids.forEach(i => { this.roundCounts[i] = 0; });
    Object.values(this.votes).forEach(to => { this.roundCounts[to]++; this.totals[to]++; });
    this.phase = "results";
    this.room.broadcast();
    this.timer = setTimeout(() => { if (this.round >= this.questions.length) this.finishAll(); else this.nextRound(); }, VOTE_RESULT_MS);
  }
  finishAll() {
    this.ranking = this.ids.slice().sort((a, b) => this.totals[b] - this.totals[a]).map(id => ({ id, score: this.totals[id], left: this.left.includes(id) }));
    const tie = this.ranking.length > 1 && this.ranking[0].score === this.ranking[1].score;
    this.room.finish(tie ? null : this.ranking[0].id);
  }
  onLeave(id) {
    if (!this.ids.includes(id) || this.left.includes(id)) return;
    this.left.push(id);
    const act = this.active();
    if (act.length <= 1) { this.stop(); this.finishAll(); return; }
    if (this.phase === "voting" && act.every(i => this.votes[i] !== undefined)) { clearTimeout(this.timer); this.endRound(); return; }
    this.room.broadcast();
  }
  state() {
    const showRes = this.phase === "results" || !!this.ranking;
    const voted = {}; Object.keys(this.votes).forEach(k => { voted[k] = true; });
    return { game: "vote", phase: this.phase, round: this.round, rounds: this.questions.length, question: this.questions[Math.max(0, this.round - 1)],
      timeLeftMs: this.phase === "voting" ? Math.max(0, this.voteEnds - Date.now()) : 0, voted, left: this.left,
      roundCounts: showRes ? this.roundCounts : null, totals: showRes ? this.totals : null, ranking: this.ranking };
  }
}

class PartyRoom {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // id -> {id, ws, pseudo, connected}
    this.nextId = 1;
    this.hostId = null;
    this.status = "lobby"; // lobby -> playing -> ended
    this.selectedGame = "simon";
    this.g = null;
    this.winnerId = null;
    this.lastActivity = Date.now();
  }
  connectedPlayers() { return Array.from(this.players.values()).filter(p => p.connected); }
  addPlayer(ws, pseudo) {
    if (this.status !== "lobby") return { error: "La partie a déjà commencé." };
    if (this.players.size >= PARTY_MAX) return { error: "Le salon est plein." };
    const id = this.nextId++;
    const player = { id, ws, pseudo: (pseudo || `Joueur ${id}`).slice(0, 16), connected: true };
    this.players.set(id, player);
    if (this.hostId === null) this.hostId = id;
    this.lastActivity = Date.now();
    this.broadcast();
    return { player };
  }
  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = false;
    if (this.status === "lobby") this.players.delete(id);
    if (this.hostId === id) {
      const next = this.connectedPlayers()[0];
      this.hostId = next ? next.id : null;
    }
    if (this.status === "playing" && this.g) this.g.onLeave(id);
    if (this.connectedPlayers().length === 0 && this.g) { this.g.stop(); this.g = null; }
    this.broadcast();
  }
  handle(id, msg) {
    this.lastActivity = Date.now();
    if (msg.type === "partySelect" && id === this.hostId && this.status === "lobby" && PARTY_GAMES.includes(msg.game)) {
      this.selectedGame = msg.game; this.broadcast();
    } else if (msg.type === "partyStart" && id === this.hostId && (this.status === "lobby" || this.status === "ended")) {
      this.startGame();
    } else if (msg.type === "partyBack" && id === this.hostId && this.status === "ended") {
      for (const [pid, p] of this.players) if (!p.connected) this.players.delete(pid);
      this.status = "lobby"; this.g = null; this.winnerId = null; this.broadcast();
    } else if (msg.type === "partyAct" && this.status === "playing" && this.g) {
      this.g.act(id, Object.assign({}, msg, { type: msg.act }));
    }
  }
  startGame() {
    const ids = this.connectedPlayers().map(p => p.id);
    if (ids.length < 2) {
      const host = this.players.get(this.hostId);
      if (host && host.ws && host.ws.readyState === 1) host.ws.send(JSON.stringify({ type: "partyError", message: "Il faut au moins 2 joueurs pour démarrer." }));
      return;
    }
    for (const [pid, p] of this.players) if (!p.connected) this.players.delete(pid);
    if (this.g) this.g.stop();
    this.winnerId = null;
    this.status = "playing";
    const GameCls = { simon: SimonParty, potato: PotatoParty, stop10: StopParty, memory: MemoryParty, taps: TapsParty, vote: VoteParty }[this.selectedGame] || SimonParty;
    this.g = new GameCls(this, ids);
    this.g.start();
    this.broadcast();
  }
  finish(winnerId) {
    if (this.g) this.g.stop();
    this.status = "ended"; this.winnerId = winnerId;
    this.broadcast();
  }
  stateFor(viewerId) {
    return {
      type: "partyState", code: this.code, status: this.status, hostId: this.hostId, myId: viewerId,
      selectedGame: this.selectedGame, winnerId: this.winnerId,
      players: Array.from(this.players.values()).map(p => ({ id: p.id, pseudo: p.pseudo, connected: p.connected })),
      game: this.status !== "lobby" && this.g ? this.g.state() : null,
    };
  }
  broadcast() {
    for (const p of this.players.values()) {
      if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(this.stateFor(p.id)));
    }
  }
}
function getOrCreatePartyRoom(code) {
  code = code.toUpperCase();
  let room = partyRooms.get(code);
  if (!room) { room = new PartyRoom(code); partyRooms.set(code, room); }
  return room;
}
const partyCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of partyRooms.entries()) {
    if (room.connectedPlayers().length === 0 && now - room.lastActivity > DUO_IDLE_CLEANUP_MS) {
      if (room.g) room.g.stop();
      partyRooms.delete(code);
    }
  }
}, 1000 * 60 * 10);
partyCleanupInterval.unref();

// ---- Serveur HTTP + WebSocket ----
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (url.pathname === "/api/duo-create" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 2000) req.destroy(); });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch (e) { /* ignore */ }
      const code = genCode();
      const duoNew = getOrCreateDuoRoom(code, parsed.game);
      duoNew.isPublic = !!parsed.isPublic;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code }));
    });
    return;
  }

  if (url.pathname === "/api/duo-public-rooms" && req.method === "GET") {
    const list = [];
    for (const room of duoRooms.values()) {
      const host = room.players.get(1);
      if (room.isPublic && room.status === "waiting" && room.players.size === 1 && host && host.connected !== false) {
        list.push({ code: room.code, game: room.game, hostPseudo: host.pseudo || "?" });
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(list));
    return;
  }

  if (url.pathname === "/api/party-create" && req.method === "POST") {
    const code = genCode();
    getOrCreatePartyRoom(code);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code }));
    return;
  }

  if (url.pathname === "/api/create" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 2000) req.destroy(); });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch (e) { /* ignore */ }
      const code = genCode();
      const room = getOrCreateRoom(code);
      room.isPublic = !!parsed.isPublic;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code }));
    });
    return;
  }

  if (url.pathname === "/api/public-rooms" && req.method === "GET") {
    const list = [];
    for (const room of rooms.values()) {
      const count = Object.keys(room.players).length;
      if (room.isPublic && room.status !== "playing" && count > 0) {
        list.push({
          code: room.code,
          hostPseudo: (room.players[room.hostId] && room.players[room.hostId].pseudo) || "?",
          players: count,
          maxPlayers: room.maxPlayers,
          status: room.status,
        });
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(list));
    return;
  }

  if (url.pathname === "/api/modes") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(MODES));
    return;
  }

  if (url.pathname === "/api/maps") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(MAPS));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("CapNaval backend OK");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/ws") { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const code = url.searchParams.get("code");
    const pseudo = (url.searchParams.get("pseudo") || "Joueur").slice(0, 16);
    if (!code) { ws.close(1008, "code manquant"); return; }

    if (url.searchParams.get("party") === "1") {
      const partyRoom = getOrCreatePartyRoom(code);
      const res2 = partyRoom.addPlayer(ws, pseudo);
      if (res2.error) { ws.send(JSON.stringify({ type: "error", message: res2.error })); ws.close(1008, "refused"); return; }
      const pl = res2.player;
      ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }
        partyRoom.handle(pl.id, msg);
      });
      ws.on("close", () => { partyRoom.removePlayer(pl.id); });
      return;
    }

    if (url.searchParams.get("duo") === "1") {
      const game = url.searchParams.get("game");
      const initialRoom = getOrCreateDuoRoom(code, game);
      const player = initialRoom.addPlayer(ws, pseudo);
      if (!player) { ws.send(JSON.stringify({ type: "error", message: "Cette partie Duo est déjà pleine." })); ws.close(1008, "full"); return; }
      ws.send(JSON.stringify({ type: "duoWelcome", num: player.num, code: initialRoom.code, game: initialRoom.game }));
      initialRoom.broadcast();
      ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }
        let duoRoom = duoRooms.get(code.toUpperCase());
        if (!duoRoom) return;
        duoRoom.lastActivity = Date.now();
        if (msg.type === "duoChangeGame") { switchDuoGame(duoRoom, msg.game); return; }
        if (msg.type === "duoRestart" && duoRoom.status === "ended") { duoRoom.restart(); return; }
        if (typeof duoRoom.handleAct === "function") { duoRoom.handleAct(player.num, msg); return; }
        if (duoRoom.game === "battleship") {
          if (msg.type === "duoPlace") duoRoom.handlePlace(player.num, msg.ships);
          else if (msg.type === "duoFire") duoRoom.handleFire(player.num, msg.r, msg.c);
        } else if (duoRoom.game === "connect4") {
          if (msg.type === "duoDrop") duoRoom.handleDrop(player.num, msg.col);
        } else if (duoRoom.game === "rps") {
          if (msg.type === "duoChoice") duoRoom.handleChoice(player.num, msg.choice);
        } else if (duoRoom.game === "checkers") {
          if (msg.type === "duoMove") duoRoom.handleMove(player.num, msg.fr, msg.fc, msg.tr, msg.tc);
        }
      });
      ws.on("close", () => {
        const cur = duoRooms.get(code.toUpperCase());
        if (cur && cur.players.get(player.num) && cur.players.get(player.num).ws === ws) cur.removePlayer(player.num);
      });
      return;
    }

    const clientId = url.searchParams.get("clientId") || null;
    const color = url.searchParams.get("color") || null;
    const avatarEmoji = url.searchParams.get("avatarEmoji") || null;
    if (!code) { ws.close(1008, "code manquant"); return; }

    const room = getOrCreateRoom(code);
    const player = room.addPlayer(ws, pseudo, clientId, { color, avatarEmoji });
    if (!player) { ws.send(JSON.stringify({ type: "error", message: "Partie pleine." })); ws.close(1008, "full"); return; }

    ws.send(JSON.stringify({
      type: "welcome", playerId: player.id, code: room.code, modes: MODES, maps: MAPS, mapModifiers: MAP_MODIFIERS, modifierTunableRanges: MODIFIER_TUNABLE_RANGES,
      attacks: ATTACKS.filter(a => !a.secret).map(a => ({ id: a.id, name: a.name, weight: a.weight !== undefined ? a.weight : 1, tunables: getAttackTunables(a) })),
    }));
    room.pushLog(`${pseudo} a rejoint la partie.`);
    room.broadcast(room.publicState());

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      room.lastActivity = Date.now();
      const p = room.players[player.id];
      if (!p) return;
      if (msg.type === "start" && player.id === room.hostId && (room.status === "lobby" || room.status === "ended")) {
        if (Object.keys(room.players).length < 2) {
          ws.send(JSON.stringify({ type: "startRefused", message: "Il faut au moins 2 joueurs (ou des bots de remplissage) pour démarrer." }));
        } else {
          room.start(msg.mode, msg.config);
        }
      } else if (msg.type === "move" && room.status === "playing") {
        room.handleMove(p, msg);
      } else if (msg.type === "attack" && room.status === "playing") {
        room.handleAttack(p, msg);
      } else if (msg.type === "endMatch" && player.id === room.hostId && room.status === "playing") {
        room.abortToLobby();
      } else if (msg.type === "backToLobby" && player.id === room.hostId && room.status === "ended") {
        room.abortToLobby();
      } else if (msg.type === "setPublic" && player.id === room.hostId) {
        room.isPublic = !!msg.value;
        room.broadcast(room.publicState());
      } else if (msg.type === "setMaxPlayers" && player.id === room.hostId && room.status === "lobby") {
        room.maxPlayers = clamp(parseInt(msg.value) || MAX_PLAYERS_HARD_CAP, 2, MAX_PLAYERS_HARD_CAP);
        room.syncBotFill();
        room.broadcast(room.publicState());
      } else if (msg.type === "setFillBots" && player.id === room.hostId && room.status === "lobby") {
        room.fillBotCount = clamp(parseInt(msg.count) || 0, 0, MAX_PLAYERS_HARD_CAP - 1);
        if (BOT_DIFFICULTIES.includes(msg.difficulty)) room.fillBotDifficulty = msg.difficulty;
        room.syncBotFill();
        room.broadcast(room.publicState());
      } else if (msg.type === "kickPlayer" && player.id === room.hostId && msg.targetId !== room.hostId) {
        room.kickPlayer(msg.targetId);
      } else if (msg.type === "transferHost" && player.id === room.hostId && msg.targetId !== room.hostId) {
        room.transferHost(msg.targetId);
      } else if (msg.type === "chooseWeapon" && room.status === "playing") {
        room.handleChooseWeapon(p, msg);
      } else if (msg.type === "cheatCode" && room.status === "playing") {
        room.handleCheatCode(p, msg);
      } else if (msg.type === "reaction" && room.status === "playing" && typeof msg.emoji === "string") {
        room.broadcast({ type: "reaction", by: player.id, emoji: msg.emoji.slice(0, 4) });
      } else if (msg.type === "leave") {
        room.removePlayerFully(player.id);
        room.broadcast(room.publicState());
        try { ws.close(1000, "left"); } catch (e) { /* ignore */ }
      }
    });

    ws.on("close", () => {
      room.handleDisconnect(player.id);
      room.broadcast(room.publicState());
    });
  });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => console.log(`CapNaval backend en écoute sur le port ${PORT}`));
}

module.exports = { Room, DuoRoom, Connect4Room, RpsRoom, CheckersRoom, MODES, MAPS, ATTACKS, DEFAULT_GRID_SIZE, RECONNECT_GRACE_MS, MAX_PLAYERS_HARD_CAP };
