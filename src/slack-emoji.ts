/**
 * Convert Slack emoji shortcodes like :muscle: to Unicode emoji.
 *
 * We ship a curated map of common emoji. Unknown shortcodes are left as-is.
 */

const emojiMap: Record<string, string> = {
  // Smileys & People
  smile: "😄", laughing: "😆", blush: "😊", smiley: "😃", relaxed: "☺️",
  heart_eyes: "😍", kissing_heart: "😘", kissing: "😗", wink: "😉",
  thinking_face: "🤔", thinking: "🤔", neutral_face: "😐", expressionless: "😑",
  unamused: "😒", sweat: "😓", pensive: "😔", confused: "😕",
  upside_down_face: "🙃", money_mouth_face: "🤑", astonished: "😲",
  frowning: "😦", anguished: "😧", cry: "😢", sob: "😭",
  joy: "😂", rofl: "🤣", slightly_smiling_face: "🙂",
  sunglasses: "😎", nerd_face: "🤓", monocle_face: "🧐",
  confused_face: "😕", worried: "😟", slightly_frowning_face: "🙁",
  open_mouth: "😮", hushed: "😯", sleepy: "😪", tired_face: "😫",
  sleeping: "😴", relieved: "😌", stuck_out_tongue: "😛",
  stuck_out_tongue_winking_eye: "😜", stuck_out_tongue_closed_eyes: "😝",
  drooling_face: "🤤", grimacing: "😬", zipper_mouth_face: "🤐",
  nauseated_face: "🤢", sneezing_face: "🤧", mask: "😷",
  face_with_thermometer: "🤒", face_with_head_bandage: "🤕",
  smiling_imp: "😈", skull: "💀", ghost: "👻", alien: "👽",
  robot_face: "🤖", poop: "💩", clown_face: "🤡",
  fire: "🔥", "100": "💯", sparkles: "✨", star: "⭐", star2: "🌟",
  zap: "⚡", boom: "💥", collision: "💥",

  // Gestures & Body
  muscle: "💪", wave: "👋", clap: "👏", thumbsup: "👍", "+1": "👍",
  thumbsdown: "👎", "-1": "👎", ok_hand: "👌", punch: "👊",
  fist: "✊", raised_hands: "🙌", pray: "🙏", point_up: "☝️",
  point_up_2: "👆", point_down: "👇", point_left: "👈", point_right: "👉",
  middle_finger: "🖕", hand: "✋", raised_hand: "✋",
  v: "✌️", metal: "🤘", crossed_fingers: "🤞",
  writing_hand: "✍️", eyes: "👀", eye: "👁️", brain: "🧠",

  // Hearts & Emotions
  heart: "❤️", orange_heart: "🧡", yellow_heart: "💛",
  green_heart: "💚", blue_heart: "💙", purple_heart: "💜",
  black_heart: "🖤", broken_heart: "💔", heavy_heart_exclamation: "❣️",
  two_hearts: "💕", revolving_hearts: "💞", heartbeat: "💓",
  sparkling_heart: "💖", heartpulse: "💗", cupid: "💘",

  // Objects & Symbols
  rocket: "🚀", airplane: "✈️", tada: "🎉", party_popper: "🎉",
  confetti_ball: "🎊", balloon: "🎈", gift: "🎁", trophy: "🏆",
  medal: "🏅", crown: "👑", gem: "💎", bulb: "💡",
  flashlight: "🔦", wrench: "🔧", hammer: "🔨", nut_and_bolt: "🔩",
  gear: "⚙️", link: "🔗", chains: "⛓️", lock: "🔒", unlock: "🔓",
  key: "🔑", bomb: "💣", knife: "🔪", pill: "💊",
  warning: "⚠️", no_entry: "⛔", x: "❌", white_check_mark: "✅",
  heavy_check_mark: "✔️", question: "❓", exclamation: "❗",
  mega: "📣", loudspeaker: "📢", bell: "🔔", no_bell: "🔕",
  bookmark: "🔖", books: "📚", book: "📖", pencil: "📝",
  pencil2: "✏️", memo: "📝", clipboard: "📋",
  calendar: "📅", chart_with_upwards_trend: "📈",
  chart_with_downwards_trend: "📉", bar_chart: "📊",

  // Tech
  computer: "💻", desktop_computer: "🖥️", keyboard: "⌨️",
  mouse: "🖱️", cd: "💿", dvd: "📀", floppy_disk: "💾",
  electric_plug: "🔌", battery: "🔋", satellite: "📡",
  tv: "📺", radio: "📻", telephone_receiver: "📞",
  iphone: "📱", calling: "📲", email: "📧", inbox_tray: "📥",
  outbox_tray: "📤", envelope: "✉️", package: "📦",

  // Nature & Weather
  sunny: "☀️", cloud: "☁️", umbrella: "☂️", snowflake: "❄️",
  rainbow: "🌈", ocean: "🌊", earth_americas: "🌎",
  seedling: "🌱", evergreen_tree: "🌲", deciduous_tree: "🌳",
  cactus: "🌵", fallen_leaf: "🍂", maple_leaf: "🍁",
  mushroom: "🍄", rose: "🌹", sunflower: "🌻", blossom: "🌼",

  // Animals
  dog: "🐶", cat: "🐱", mouse_face: "🐭", bear: "🐻",
  panda_face: "🐼", penguin: "🐧", bird: "🐦", eagle: "🦅",
  butterfly: "🦋", bug: "🐛", bee: "🐝", turtle: "🐢",
  snake: "🐍", unicorn_face: "🦄", unicorn: "🦄",

  // Food & Drink
  coffee: "☕", tea: "🍵", beer: "🍺", beers: "🍻",
  wine_glass: "🍷", cocktail: "🍸", pizza: "🍕",
  hamburger: "🍔", taco: "🌮", burrito: "🌯",
  cookie: "🍪", cake: "🎂", ice_cream: "🍦",

  // Arrows & Misc
  arrow_right: "➡️", arrow_left: "⬅️", arrow_up: "⬆️", arrow_down: "⬇️",
  arrow_upper_right: "↗️", arrow_lower_right: "↘️",
  arrow_upper_left: "↖️", arrow_lower_left: "↙️",
  leftwards_arrow_with_hook: "↩️", arrow_right_hook: "↪️",
  arrows_counterclockwise: "🔄", arrow_forward: "▶️",
  arrow_backward: "◀️", fast_forward: "⏩", rewind: "⏪",
  infinity: "♾️", recycle: "♻️",
};

/**
 * Replace all :emoji_name: shortcodes in a string with Unicode emoji.
 * Unknown shortcodes are left untouched.
 */
export function convertSlackEmoji(text: string): string {
  return text.replace(/:([a-z0-9_+-]+):/g, (match, code) => {
    return emojiMap[code] || match;
  });
}
