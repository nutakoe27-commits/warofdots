/**
 * Localisation for the shell: menu, setup, settings, end screen, tutorial.
 *
 * Two flat dictionaries, Russian first. Two deliberate choices here. `t()` returns
 * the key itself when it is missing, so a typo at a call site shows up as
 * `menu.strat` on screen instead of taking the screen down. The dictionaries are
 * checked against each other at import time, so the *other* kind of typo — a key
 * added to one language and forgotten in the other — is a hard error while the
 * literals are still in front of whoever added them.
 *
 * The in-match HUD is not routed through here: its labels are written by the panels
 * themselves, and re-labelling a live HUD mid-match is not something the shell asks
 * for. Only the shell subscribes to locale changes.
 */

export type Locale = 'ru' | 'en';

export const LOCALES: readonly Locale[] = ['ru', 'en'];

const RU: Record<string, string> = {
  'app.title': 'dotfront',
  'app.subtitle': 'Минималистичный варгейм точек',

  'menu.setup': 'Схватка',
  'menu.map': 'Карта',
  'menu.map.players': '{n} игр.',
  'menu.seed': 'Зерно',
  'menu.seed.random': 'Случайно',
  'menu.victory': 'Условие победы',
  'menu.timeLimit': 'Лимит времени',
  'menu.minutes': 'мин',
  'menu.roster': 'Состав',
  'menu.slot': 'Слот {n}',
  'menu.difficulty': 'Сложность',
  'menu.team': 'Команда',
  'menu.team.n': 'Команда {n}',
  'menu.handicap': 'Гандикап Маршала',
  'menu.handicap.hint':
    'Маршал получает +{pct}% к доходу. Только на максимальной сложности и всегда подписано.',
  'menu.start': 'Начать',
  'menu.settings': 'Настройки',
  'menu.help': 'Как играть',

  'menu.note.padded': 'Свободные места на карте займут Лейтенанты: {n}.',
  'menu.error.tooMany': 'На карте «{map}» помещается {n} игроков, а активных слотов {have}.',
  'menu.error.tooFew': 'Нужно не меньше двух активных слотов.',
  'menu.error.oneTeam': 'Все активные слоты в одной команде — воевать не с кем.',

  'victory.CAPITAL_AND_MAJORITY': 'Столица и большинство городов',
  'victory.ANNIHILATION': 'Уничтожение',
  'victory.TIMED_SCORE': 'По очкам за время',
  'victory.hint.CAPITAL_AND_MAJORITY':
    'Взять вражескую столицу и держать не меньше 80% городов карты.',
  'victory.hint.ANNIHILATION': 'Уничтожить все вражеские юниты и забрать все города.',
  'victory.hint.TIMED_SCORE': 'Когда время выйдет, побеждают очки: города ×10, юниты ×1, территория.',

  'slot.human': 'Игрок',
  'slot.bot': 'Бот',
  'slot.off': 'Выкл.',

  'bot.recruit': 'Новобранец',
  'bot.lieutenant': 'Лейтенант',
  'bot.colonel': 'Полковник',
  'bot.general': 'Генерал',
  'bot.marshal': 'Маршал',

  'settings.theme': 'Тема',
  'settings.colorblind': 'Режим для дальтоников',
  'settings.colorblind.hint': 'Столицы различаются формой маркера, а не только цветом.',
  'settings.cameraSpeed': 'Чувствительность камеры',
  'settings.volume': 'Громкость',
  'settings.locale': 'Язык',
  'settings.territory': 'Показывать территорию',

  'theme.dark': 'Тёмная',
  'theme.light': 'Светлая',
  'locale.ru': 'Русский',
  'locale.en': 'English',

  'tutorial.title': 'Четыре шага',
  'tutorial.step1': 'Обведите свои точки лассо левой кнопкой. Shift — добавить к выделению.',
  'tutorial.step2': 'Правой кнопкой нарисуйте путь. Короткий клик — прямая линия.',
  'tutorial.step3': 'Ползунки производства решают, как быстро и кого строят города.',
  'tutorial.step4': 'Города дают доход и снабжение. Отрезанная от них армия тает.',
  'tutorial.next': 'Дальше',
  'tutorial.skip': 'Пропустить',
  'tutorial.done': 'Понятно',

  'keys.title': 'Горячие клавиши',
  'keys.row.select': 'ЛКМ — выделить, перетаскивание — лассо, Shift — добавить',
  'keys.row.path': 'ПКМ — путь: клик даёт прямую, перетаскивание — кривую',
  'keys.row.orders': 'S — стоп, C — сбросить приказы, Ctrl+A / Ctrl+H / Ctrl+L — все / тяжёлые / лёгкие',
  'keys.row.groups': 'Ctrl+1…9 — назначить группу, 1…9 — выбрать',
  'keys.row.camera': 'Камера: A / W / D / X и стрелки, колесо — зум, край экрана — прокрутка',
  'keys.row.debug': 'Space — пауза, + / − — скорость, F3 — оверлей бота, F4 — отладка, Esc — меню',

  'end.win': 'Победа',
  'end.lose': 'Поражение',
  'end.draw': 'Ничья',
  'end.over': 'Матч завершён',
  'end.reason.capital': 'Столица взята, большинство городов под контролем.',
  'end.reason.annihilation': 'Противник уничтожен полностью.',
  'end.reason.timeout': 'Время вышло — считаем очки.',
  'end.reason.lastStanding': 'Все остальные выбыли.',
  'end.reason.draw': 'Никто не добился перевеса.',
  'end.winner': 'Победитель: {names}',
  'end.duration': 'Длительность',
  'end.player': 'Игрок',
  'end.you': 'вы',
  'end.produced': 'Произведено',
  'end.lost': 'Потеряно',
  'end.peakArmy': 'Пик армии',
  'end.captured': 'Захвачено',
  'end.cities': 'Города',
  'end.territory': 'Территория',
  'end.score': 'Очки',
  'end.chart.eco': 'Экономика',
  'end.chart.army': 'Армия',
  'end.chart.time': 'Время',
  'end.chart.empty': 'Матч кончился раньше первой выборки.',
  'end.restart': 'Ещё раз',
  'end.exit': 'В меню',
};

const EN: Record<string, string> = {
  'app.title': 'dotfront',
  'app.subtitle': 'A minimalist wargame of dots',

  'menu.setup': 'Skirmish',
  'menu.map': 'Map',
  'menu.map.players': '{n} pl.',
  'menu.seed': 'Seed',
  'menu.seed.random': 'Randomise',
  'menu.victory': 'Victory condition',
  'menu.timeLimit': 'Time limit',
  'menu.minutes': 'min',
  'menu.roster': 'Roster',
  'menu.slot': 'Slot {n}',
  'menu.difficulty': 'Difficulty',
  'menu.team': 'Team',
  'menu.team.n': 'Team {n}',
  'menu.handicap': 'Marshal handicap',
  'menu.handicap.hint':
    'The Marshal gets +{pct}% income. Top difficulty only, and always spelled out.',
  'menu.start': 'Start',
  'menu.settings': 'Settings',
  'menu.help': 'How to play',

  'menu.note.padded': 'Lieutenants will fill the empty seats on this map: {n}.',
  'menu.error.tooMany': 'Map "{map}" seats {n} players, but {have} slots are active.',
  'menu.error.tooFew': 'At least two slots have to be active.',
  'menu.error.oneTeam': 'Every active slot is on the same team — nobody to fight.',

  'victory.CAPITAL_AND_MAJORITY': 'Capital and city majority',
  'victory.ANNIHILATION': 'Annihilation',
  'victory.TIMED_SCORE': 'Timed score',
  'victory.hint.CAPITAL_AND_MAJORITY':
    'Take an enemy capital and hold at least 80% of the cities on the map.',
  'victory.hint.ANNIHILATION': 'Destroy every enemy unit and take every enemy city.',
  'victory.hint.TIMED_SCORE': 'When time runs out, score decides: cities ×10, units ×1, territory.',

  'slot.human': 'Human',
  'slot.bot': 'Bot',
  'slot.off': 'Off',

  'bot.recruit': 'Recruit',
  'bot.lieutenant': 'Lieutenant',
  'bot.colonel': 'Colonel',
  'bot.general': 'General',
  'bot.marshal': 'Marshal',

  'settings.theme': 'Theme',
  'settings.colorblind': 'Colour-blind mode',
  'settings.colorblind.hint': 'Capitals are told apart by marker shape, not by hue alone.',
  'settings.cameraSpeed': 'Camera sensitivity',
  'settings.volume': 'Volume',
  'settings.locale': 'Language',
  'settings.territory': 'Show territory',

  'theme.dark': 'Dark',
  'theme.light': 'Light',
  'locale.ru': 'Русский',
  'locale.en': 'English',

  'tutorial.title': 'Four steps',
  'tutorial.step1': 'Lasso your dots with the left button. Hold Shift to add to the selection.',
  'tutorial.step2': 'Draw a path with the right button. A short click gives a straight line.',
  'tutorial.step3': 'The production sliders decide how fast your cities build, and what.',
  'tutorial.step4': 'Cities pay and supply you. An army cut off from them melts away.',
  'tutorial.next': 'Next',
  'tutorial.skip': 'Skip',
  'tutorial.done': 'Got it',

  'keys.title': 'Hotkeys',
  'keys.row.select': 'LMB to select, drag to lasso, Shift to add',
  'keys.row.path': 'RMB for a path: click gives a line, drag gives a curve',
  'keys.row.orders': 'S stop, C clear orders, Ctrl+A / Ctrl+H / Ctrl+L all / heavy / light',
  'keys.row.groups': 'Ctrl+1…9 assign a group, 1…9 recall it',
  'keys.row.camera': 'Camera: A / W / D / X and the arrows, wheel to zoom, screen edge to pan',
  'keys.row.debug': 'Space pause, + / − speed, F3 bot overlay, F4 debug, Esc menu',

  'end.win': 'Victory',
  'end.lose': 'Defeat',
  'end.draw': 'Draw',
  'end.over': 'Match over',
  'end.reason.capital': 'A capital fell and the city majority held.',
  'end.reason.annihilation': 'The enemy was wiped out.',
  'end.reason.timeout': 'Time ran out — the score decides.',
  'end.reason.lastStanding': 'Everyone else was eliminated.',
  'end.reason.draw': 'Nobody came out ahead.',
  'end.winner': 'Winner: {names}',
  'end.duration': 'Duration',
  'end.player': 'Player',
  'end.you': 'you',
  'end.produced': 'Produced',
  'end.lost': 'Lost',
  'end.peakArmy': 'Peak army',
  'end.captured': 'Captured',
  'end.cities': 'Cities',
  'end.territory': 'Territory',
  'end.score': 'Score',
  'end.chart.eco': 'Economy',
  'end.chart.army': 'Army',
  'end.chart.time': 'Time',
  'end.chart.empty': 'The match ended before the first sample.',
  'end.restart': 'Play again',
  'end.exit': 'Main menu',
};

const DICTS: Record<Locale, Record<string, string>> = { ru: RU, en: EN };

const gaps = [
  ...Object.keys(RU).filter((k) => EN[k] === undefined),
  ...Object.keys(EN).filter((k) => RU[k] === undefined),
];
if (gaps.length > 0) {
  throw new Error(`i18n: dictionaries are out of step on ${gaps.join(', ')}`);
}

const PARAM = /\{(\w+)\}/g;

let current: Locale = 'ru';
const listeners = new Set<() => void>();

export function setLocale(l: Locale): void {
  if (l === current) return;
  current = l;
  document.documentElement.lang = l;
  // Copied, so a listener that unsubscribes itself cannot break the walk.
  for (const fn of [...listeners]) fn();
}

export function getLocale(): Locale {
  return current;
}

export function isLocale(v: unknown): v is Locale {
  return v === 'ru' || v === 'en';
}

export function t(key: string, params?: Record<string, string | number>): string {
  const raw = DICTS[current][key];
  if (raw === undefined) return key;
  if (params === undefined) return raw;
  return raw.replace(PARAM, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** Subscribes to locale changes and returns the unsubscribe. */
export function onLocaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
