/**
 * Cities and countries a posting may name. Anything else in a location string
 * (an office nickname, a building, "3 Locations") is ignored, so two boards
 * that describe one city differently can still meet.
 * The value is the country of that city, used when one copy names only a country.
 */
const CITIES: Record<string, string> = {
  berlin: "germany",
  munich: "germany",
  muenchen: "germany",
  "münchen": "germany",
  munchen: "germany",
  hamburg: "germany",
  cologne: "germany",
  koeln: "germany",
  "köln": "germany",
  koln: "germany",
  frankfurt: "germany",
  "frankfurt am main": "germany",
  dusseldorf: "germany",
  "düsseldorf": "germany",
  duesseldorf: "germany",
  stuttgart: "germany",
  chemnitz: "germany",
  leipzig: "germany",
  dresden: "germany",
  hannover: "germany",
  hanover: "germany",
  nuremberg: "germany",
  "nürnberg": "germany",
  nuernberg: "germany",
  bremen: "germany",
  essen: "germany",
  dortmund: "germany",
  bonn: "germany",
  mannheim: "germany",
  karlsruhe: "germany",
  augsburg: "germany",
  wiesbaden: "germany",
  mainz: "germany",
  kiel: "germany",
  freiburg: "germany",
  heidelberg: "germany",
  aachen: "germany",
  münster: "germany",
  muenster: "germany",
  bielefeld: "germany",
  wolfsburg: "germany",
  potsdam: "germany",
  erfurt: "germany",
  rostock: "germany",
  luebeck: "germany",
  "lübeck": "germany",
  vienna: "austria",
  wien: "austria",
  salzburg: "austria",
  graz: "austria",
  linz: "austria",
  innsbruck: "austria",
  zurich: "switzerland",
  "zürich": "switzerland",
  zuerich: "switzerland",
  geneva: "switzerland",
  genf: "switzerland",
  basel: "switzerland",
  bern: "switzerland",
  lausanne: "switzerland",
  lugano: "switzerland",
  london: "uk",
  manchester: "uk",
  birmingham: "uk",
  edinburgh: "uk",
  glasgow: "uk",
  leeds: "uk",
  bristol: "uk",
  cambridge: "uk",
  oxford: "uk",
  reading: "uk",
  brighton: "uk",
  cardiff: "uk",
  belfast: "uk",
  paris: "france",
  lyon: "france",
  marseille: "france",
  toulouse: "france",
  lille: "france",
  nantes: "france",
  bordeaux: "france",
  strasbourg: "france",
  nice: "france",
  amsterdam: "netherlands",
  rotterdam: "netherlands",
  utrecht: "netherlands",
  eindhoven: "netherlands",
  "the hague": "netherlands",
  brussels: "belgium",
  antwerp: "belgium",
  ghent: "belgium",
  luxembourg: "luxembourg",
  dublin: "ireland",
  cork: "ireland",
  madrid: "spain",
  barcelona: "spain",
  valencia: "spain",
  seville: "spain",
  malaga: "spain",
  bilbao: "spain",
  lisbon: "portugal",
  porto: "portugal",
  milan: "italy",
  rome: "italy",
  turin: "italy",
  florence: "italy",
  bologna: "italy",
  naples: "italy",
  warsaw: "poland",
  krakow: "poland",
  "kraków": "poland",
  wroclaw: "poland",
  gdansk: "poland",
  poznan: "poland",
  prague: "czech",
  brno: "czech",
  budapest: "hungary",
  bucharest: "romania",
  cluj: "romania",
  sofia: "bulgaria",
  athens: "greece",
  stockholm: "sweden",
  gothenburg: "sweden",
  malmo: "sweden",
  oslo: "norway",
  bergen: "norway",
  copenhagen: "denmark",
  aarhus: "denmark",
  helsinki: "finland",
  tallinn: "estonia",
  riga: "latvia",
  vilnius: "lithuania",
  zagreb: "croatia",
  ljubljana: "slovenia",
  bratislava: "slovakia",
  "new york": "us",
  "new york city": "us",
  nyc: "us",
  "san francisco": "us",
  "palo alto": "us",
  austin: "us",
  boston: "us",
  seattle: "us",
  chicago: "us",
  "los angeles": "us",
  denver: "us",
  atlanta: "us",
  miami: "us",
  washington: "us",
  "san jose": "us",
  "mountain view": "us",
  sunnyvale: "us",
  "menlo park": "us",
  "redwood city": "us",
  cupertino: "us",
  oakland: "us",
  berkeley: "us",
  portland: "us",
  philadelphia: "us",
  dallas: "us",
  houston: "us",
  "tel aviv": "israel",
  bengaluru: "india",
  bangalore: "india",
  delhi: "india",
  "new delhi": "india",
  mumbai: "india",
  hyderabad: "india",
  pune: "india",
  chennai: "india",
  gurugram: "india",
  gurgaon: "india",
  noida: "india",
  singapore: "singapore",
  "hong kong": "hong kong",
  tokyo: "japan",
  seoul: "south korea",
  sydney: "australia",
  melbourne: "australia",
  toronto: "canada",
  vancouver: "canada",
  montreal: "canada",
  dubai: "uae",
  "abu dhabi": "uae",
}

/** Country names and codes. Bare "ca" stays a US state, not Canada. */
const COUNTRIES: Record<string, string> = {
  germany: "germany",
  deutschland: "germany",
  de: "germany",
  deu: "germany",
  uk: "uk",
  "united kingdom": "uk",
  "great britain": "uk",
  england: "uk",
  gb: "uk",
  gbr: "uk",
  us: "us",
  usa: "us",
  "united states": "us",
  france: "france",
  frankreich: "france",
  fr: "france",
  spain: "spain",
  spanien: "spain",
  es: "spain",
  italy: "italy",
  italien: "italy",
  it: "italy",
  netherlands: "netherlands",
  niederlande: "netherlands",
  holland: "netherlands",
  nl: "netherlands",
  austria: "austria",
  "österreich": "austria",
  oesterreich: "austria",
  at: "austria",
  switzerland: "switzerland",
  schweiz: "switzerland",
  ch: "switzerland",
  poland: "poland",
  polen: "poland",
  pl: "poland",
  sweden: "sweden",
  schweden: "sweden",
  se: "sweden",
  norway: "norway",
  norwegen: "norway",
  no: "norway",
  denmark: "denmark",
  daenemark: "denmark",
  "dänemark": "denmark",
  dk: "denmark",
  finland: "finland",
  finnland: "finland",
  fi: "finland",
  ireland: "ireland",
  irland: "ireland",
  ie: "ireland",
  belgium: "belgium",
  belgien: "belgium",
  be: "belgium",
  portugal: "portugal",
  pt: "portugal",
  czech: "czech",
  czechia: "czech",
  tschechien: "czech",
  cz: "czech",
  hungary: "hungary",
  ungarn: "hungary",
  hu: "hungary",
  romania: "romania",
  rumaenien: "romania",
  ro: "romania",
  greece: "greece",
  griechenland: "greece",
  gr: "greece",
  israel: "israel",
  india: "india",
  indien: "india",
  canada: "canada",
  kanada: "canada",
  singapore: "singapore",
  japan: "japan",
  australia: "australia",
  uae: "uae",
  "united arab emirates": "uae",
}

/** Too wide to prove two postings are the same opening. */
const BROAD = new Set(["remote", "hybrid", "onsite", "office", "emea", "europe", "worldwide", "global", "anywhere", "dach"])

/**
 * US state and German land codes. They are not part of the key when a city or
 * country is also written, so "Berlin, BE" stays Berlin rather than Belgium.
 * A code that is also a country ("BE") is kept only when it is the whole place.
 */
const REGION_CODES = new Set(
  `al ak az ar ca co ct dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy bw by be bb hb hh he mv ni nw rp sl sn st sh th`.split(
    " ",
  ),
)

const CITY_NAMES = new Map<string, { name: string; country: string }>()
for (const [alias, country] of Object.entries(CITIES)) {
  const name =
    alias === "muenchen" || alias === "münchen" || alias === "munchen"
      ? "munich"
      : alias === "koeln" || alias === "köln" || alias === "koln"
        ? "cologne"
        : alias === "nyc" || alias === "new york city"
          ? "new york"
          : alias === "wien"
            ? "vienna"
            : alias === "zürich" || alias === "zuerich"
              ? "zurich"
              : alias === "bangalore"
                ? "bengaluru"
                : alias === "gurgaon"
                  ? "gurugram"
                  : alias === "new delhi"
                    ? "delhi"
                    : alias === "kraków"
                      ? "krakow"
                      : alias === "nürnberg" || alias === "nuernberg"
                        ? "nuremberg"
                        : alias === "düsseldorf" || alias === "duesseldorf"
                          ? "dusseldorf"
                          : alias === "münster" || alias === "muenster"
                            ? "munster"
                            : alias
  CITY_NAMES.set(alias, { name, country })
}

export type PlaceSet = {
  cities: string[]
  countries: string[]
  /** Remote, EMEA, Europe, worldwide. These never prove a match on their own. */
  broad: boolean
}

const EMPTY: PlaceSet = { cities: [], countries: [], broad: false }

const PLACEHOLDER = /^\d+\s+locations?$/i

function absorb(words: string[], into: { cities: Set<string>; countries: Set<string>; broad: boolean; regions: Set<string> }) {
  let index = 0
  while (index < words.length) {
    let matched = false
    const room = Math.min(3, words.length - index)
    for (let size = room; size >= 1; size--) {
      const phrase = words.slice(index, index + size).join(" ")
      if (BROAD.has(phrase)) {
        into.broad = true
        index += size
        matched = true
        break
      }
      if (REGION_CODES.has(phrase)) {
        into.regions.add(phrase)
        index += size
        matched = true
        break
      }
      const city = CITY_NAMES.get(phrase)
      if (city) {
        into.cities.add(city.name)
        index += size
        matched = true
        break
      }
      const country = COUNTRIES[phrase]
      if (country) {
        into.countries.add(country)
        index += size
        matched = true
        break
      }
    }
    if (!matched) index += 1
  }
}

/** Cities and countries actually named. Office nicknames and "3 Locations" contribute nothing. */
export function parsePlaces(location: string | null | undefined): PlaceSet {
  if (!location?.trim() || PLACEHOLDER.test(location.trim())) return EMPTY
  const found = { cities: new Set<string>(), countries: new Set<string>(), broad: false, regions: new Set<string>() }
  const text = location.toLowerCase().replace(/[()]/g, " ")
  for (const segment of text.split(/\s*(?:[;,/|]|\bor\b)\s*/)) {
    const words = segment
      .replace(/-/g, " ")
      .replace(/\bon site\b/g, " ")
      .split(/\s+/)
      .filter(Boolean)
    absorb(words, found)
  }
  if (found.cities.size === 0 && found.countries.size === 0) {
    for (const region of found.regions) {
      const country = COUNTRIES[region]
      if (country) found.countries.add(country)
    }
  }
  const cities = [...found.cities].sort()
  const countries = [...found.countries].sort()
  return { cities, countries, broad: found.broad }
}

/** Sorted city and country tokens. Broad words such as "remote" are not part of the key. */
export function locationKey(location: string | null | undefined): string {
  const place = parsePlaces(location)
  return [...place.cities, ...place.countries].sort().join("+")
}

export function placeCount(location: string | null | undefined): number {
  const place = parsePlaces(location)
  return place.cities.length + place.countries.length
}

function cityInCountry(city: string, country: string): boolean {
  for (const entry of CITY_NAMES.values()) {
    if (entry.name === city && entry.country === country) return true
  }
  return false
}

/**
 * Whether two postings can be the same opening. A shared city is enough.
 * A country matches a city list only when every city is in that country.
 * Remote, EMEA, Europe and an unknown place never glue a located role.
 */
export function placesMatch(left: PlaceSet, right: PlaceSet): boolean {
  const leftKnown = left.cities.length + left.countries.length > 0
  const rightKnown = right.cities.length + right.countries.length > 0
  if (!leftKnown || !rightKnown) return !left.broad && !right.broad && !leftKnown && !rightKnown
  if (left.broad && left.cities.length === 0) return false
  if (right.broad && right.cities.length === 0) return false
  if (left.cities.length > 0 && right.cities.length > 0) {
    return left.cities.some((city) => right.cities.includes(city))
  }
  if (left.cities.length === 0 && right.cities.length === 0) {
    return left.countries.some((country) => right.countries.includes(country))
  }
  const countrySide = left.cities.length === 0 ? left : right
  const citySide = left.cities.length === 0 ? right : left
  return countrySide.countries.some((country) => citySide.cities.every((city) => cityInCountry(city, country)))
}

/** True when the text names only a place or a way of working, so a title may drop it. */
export function isPlaceOnly(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/-/g, " ")
    .replace(/\bon site\b/g, " ")
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return true
  if (/^(all genders|any gender|diverse)$/.test(words.join(" "))) return true
  let index = 0
  while (index < words.length) {
    let matched = false
    const room = Math.min(3, words.length - index)
    for (let size = room; size >= 1; size--) {
      const phrase = words.slice(index, index + size).join(" ")
      if (BROAD.has(phrase) || REGION_CODES.has(phrase) || CITY_NAMES.has(phrase) || COUNTRIES[phrase]) {
        index += size
        matched = true
        break
      }
    }
    if (!matched) return false
  }
  return true
}
