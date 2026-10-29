/**
 * GOVERNMENT ADDRESS-POINT SERVICES that the National Address Database does
 * not carry.
 *
 * NAD is assembled from whatever states volunteer, county by county, and a
 * measured 5km-box probe found zero points in Detroit, Pittsburgh, Las Vegas
 * and several other payroll-heavy cities. The addressing authority in those
 * places (a county GIS office, an E911 office, a city) often publishes its
 * own address-point layer on a public ArcGIS REST server. That is the same
 * kind of evidence NAD holds: a point placed by the government that assigns
 * the address. So these points are merged into the NAD points BEFORE the
 * exact-match and neighbour tiers run (see resolveRooftop in rooftop.ts) and
 * are reported as 'authoritative' with the publishing government named in
 * each point's `source`. They are not a new, weaker tier.
 *
 * TWO KINDS OF SOURCE
 *   - 'layer': an address-point layer queried by bounding box, one record per
 *     address, fields mapped below. Every source here was queried live and
 *     checked against real addresses before it was registered.
 *   - 'socrata': the same kind of address-point table, published on a city's
 *     Socrata open-data portal and queried by distance from the point (San
 *     Francisco's Enterprise Addressing System).
 *   - 'geocoder': a government GeocodeServer built on its site-address
 *     points (West Virginia's statewide SAMS-II locator). Used only for an
 *     exact point-address match, never for an interpolated street match.
 *
 * WHAT THIS DOES NOT DO: decide which point IS the address. matchAddressPoint
 * in rooftop.ts keeps every guard (house number, directional, street type,
 * unit). A source that returns nothing, errors, or lies outside its `bounds`
 * is indistinguishable from "not registered", and the pipeline falls through
 * exactly as before.
 *
 * Like parcel.ts, this is a REGISTRY OF INDIVIDUALLY VERIFIED SERVICES. There
 * is no national list. An area absent here was not researched, which is not
 * the same as having no public service.
 */
import type { FetchOptions } from './census.ts';
import type { AddressPoint } from './rooftop.ts';
import { parseAddressParts } from './rooftop.ts';
import { hasStreetType, streetDirectionals, streetKey, streetKeyWithoutDirectionals, STREET_TYPES } from './buildings.ts';

interface SourceBase {
  /** Short stable id, used in tests and logs. */
  id: string;
  /** Two-letter state this source answers for. */
  state: string;
  /** [minLat, minLon, maxLat, maxLon]. A point outside it is never sent to this service. */
  bounds: [number, number, number, number];
  /** Provenance, written onto every point as AddressPoint.source. */
  source: string;
}

export interface LayerPointSource extends SourceBase {
  kind: 'layer';
  /** ArcGIS layer endpoint, ending in /query. */
  queryUrl: string;
  /** Field holding the house number. */
  numberField: string;
  /** A row is skipped when ANY of these is non-empty (a prefix or suffix such as "1/2" or "B" that AddressPoint.houseNumber cannot carry without guessing). */
  skipIfSetFields?: string[];
  /** Street-name fields in the order they are written: directional, name, type, trailing directional. */
  streetFields: string[];
  /** A street-name field that holds a bare number ("2" for NE 2nd Ave, as City of Miami writes its grid); it is rewritten to its ordinal ("2nd") so it compares with how addresses are normally written. */
  ordinalizeNumericField?: string;
  unitField?: string;
  cityField?: string;
  zipField?: string;
  /** Optional SQL filter, e.g. only active addresses. */
  where?: string;
}

export interface GeocoderPointSource extends SourceBase {
  kind: 'geocoder';
  /** GeocodeServer endpoint, ending in /findAddressCandidates. */
  findUrl: string;
  /** Minimum geocoder score (0-100) for a candidate to count. */
  minScore: number;
}

export interface SocrataPointSource extends SourceBase {
  kind: 'socrata';
  /** Resource endpoint, e.g. https://data.sfgov.org/resource/ramy-di5m.json */
  resourceUrl: string;
  /** The point-type column used for the distance filter. */
  locationField: string;
  numberField: string;
  skipIfSetFields?: string[];
  streetFields: string[];
  /** See LayerPointSource.ordinalizeNumericField. */
  ordinalizeNumericField?: string;
  unitField?: string;
  zipField?: string;
  /** Plain latitude/longitude columns... */
  latField?: string;
  lonField?: string;
  /** ...or one GeoJSON point column ({"type":"Point","coordinates":[lon,lat]}). */
  geoJsonField?: string;
}

export type AddressPointSourceConfig = LayerPointSource | GeocoderPointSource | SocrataPointSource;

export const ADDRESS_POINT_SOURCES: AddressPointSourceConfig[] = [
  {
    kind: 'layer',
    id: 'allegheny-pa',
    state: 'PA',
    bounds: [40.19, -80.52, 40.67, -79.69],
    queryUrl: 'https://gisdata.alleghenycounty.us/arcgis/rest/services/Addressing/Addressing_AddressPoints/MapServer/0/query',
    numberField: 'ADDR_NUM',
    skipIfSetFields: ['ADDR_NUM_PREFIX', 'ADDR_NUM_SUFFIX'],
    streetFields: ['ST_PREMODIFIER', 'ST_PREFIX', 'ST_PRETYPE', 'ST_NAME', 'ST_TYPE', 'ST_SUFFIX', 'ST_POSTMODIFIER'],
    unitField: 'UNIT',
    cityField: 'MUNICIPALITY',
    zipField: 'ZIP_CODE',
    where: "STATUS = 'ACTIVE'",
    source: 'Allegheny County GIS, Address Points (gisdata.alleghenycounty.us)',
  },
  // City of Miami's own base address layer. It is also a property-tax record
  // (owner names, values), so only the address columns are ever requested.
  {
    kind: 'layer',
    id: 'miami-fl',
    state: 'FL',
    bounds: [25.70, -80.32, 25.88, -80.12],
    queryUrl: 'https://gis.miami.gov/gis/rest/services/Maps/AllAddresses/MapServer/0/query',
    numberField: 'STNUMBER',
    streetFields: ['STQUAD', 'STNAME', 'STTYPE'],
    ordinalizeNumericField: 'STNAME',
    unitField: 'SUITE',
    zipField: 'ZIPCODE',
    source: 'City of Miami GIS, All City Addresses (gis.miami.gov)',
  },
  // Mississippi's MARIS hosts county point-address layers contributed by each
  // county's 911 office. Hinds County (Jackson itself) is not among them;
  // Madison and Rankin, the two suburban counties, are.
  {
    kind: 'layer',
    id: 'madison-ms',
    state: 'MS',
    bounds: [32.38, -90.46, 32.90, -89.72],
    queryUrl: 'https://gis.mississippi.edu/server/rest/services/CountyPointAddresses/Madison_PointAddresses_2023/MapServer/0/query',
    numberField: 'Address',
    skipIfSetFields: ['AddPre', 'AddSuf'],
    streetFields: ['PreMod', 'PreDir', 'PreTyp', 'Street', 'StreetType', 'SufDir', 'SufMod'],
    unitField: 'BldgUnit',
    cityField: 'Post_Comm',
    zipField: 'Zipcode',
    source: 'Madison County, MS 911 via MARIS, Point Addresses 2023 (gis.mississippi.edu)',
  },
  {
    kind: 'layer',
    id: 'rankin-ms',
    state: 'MS',
    bounds: [32.0, -90.4, 32.5, -89.7],
    queryUrl: 'https://gis.mississippi.edu/server/rest/services/CountyPointAddresses/Rankin_PointAddresses_2023/MapServer/0/query',
    numberField: 'ST_NUMBER',
    skipIfSetFields: ['ST_NUMSUFF'],
    streetFields: ['ST_PREFIXD', 'ST_NAME', 'ST_TYPE', 'ST_SUFFIXD'],
    unitField: 'UNIT',
    cityField: 'COMMUNITY',
    zipField: 'ZIPCODE',
    source: 'Rankin County, MS 911 via MARIS, Point Addresses 2023 (gis.mississippi.edu)',
  },
  // Ada County, ID address exchange (Boise, Meridian, Kuna, county), hosted by
  // the City of Boise: 275,171 points. Boise is one of the cities NAD has none for.
  {
    kind: 'layer',
    id: 'ada-id',
    state: 'ID',
    bounds: [43.2, -116.7, 43.9, -115.8],
    queryUrl: 'https://services1.arcgis.com/WHM6qC35aMtyAAlN/ArcGIS/rest/services/Ada_County_Addresses/FeatureServer/0/query',
    numberField: 'AddNum',
    skipIfSetFields: ['AddPfx', 'AddSfx'],
    streetFields: ['StPreMod', 'StPreDir', 'StPrefix', 'StName', 'StSuffix', 'StPostDir', 'StPostMod'],
    unitField: 'PrUnitID',
    cityField: 'CommName',
    zipField: 'Zip4',
    source: 'Ada County Address Exchange via City of Boise GIS (services1.arcgis.com)',
  },
  // Hennepin County, MN (Minneapolis and 44 other cities): 493,787 points,
  // street types and directions written out in full ("Avenue", "South").
  {
    kind: 'layer',
    id: 'hennepin-mn',
    state: 'MN',
    bounds: [44.75, -93.8, 45.3, -93.15],
    queryUrl: 'https://gis.hennepin.us/arcgis/rest/services/HennepinData/LAND_PROPERTY/MapServer/0/query',
    numberField: 'ANUMBER',
    skipIfSetFields: ['ANUMBERSUF'],
    streetFields: ['ST_PRE_MOD', 'ST_PRE_DIR', 'ST_PRE_TYP', 'ST_NAME', 'ST_POS_TYP', 'ST_POS_DIR', 'ST_POS_MOD'],
    unitField: 'SUB_AD_ID',
    cityField: 'MUNI_NAME',
    zipField: 'ZIP',
    source: 'Hennepin County GIS, Address Points (gis.hennepin.us)',
  },
  // San Francisco's Enterprise Addressing System, the City's master address
  // list (every address and unit), published on DataSF.
  {
    kind: 'socrata',
    id: 'sf-ca',
    state: 'CA',
    bounds: [37.6, -123.05, 37.95, -122.3],
    resourceUrl: 'https://data.sfgov.org/resource/ramy-di5m.json',
    locationField: 'point',
    numberField: 'address_number',
    skipIfSetFields: ['address_number_suffix'],
    streetFields: ['street_name', 'street_type'],
    unitField: 'unit_number',
    zipField: 'zip_code',
    latField: 'latitude',
    lonField: 'longitude',
    source: 'City and County of San Francisco, Enterprise Addressing System (data.sfgov.org)',
  },
  // NYC Planning's address points (all five boroughs). Queens hyphenated house
  // numbers ("12-34") are skipped, not guessed at. Street names for the numbered
  // grid are bare numbers ("42" + "ST"), rewritten to ordinals like Miami's.
  {
    kind: 'socrata',
    id: 'nyc-ny',
    state: 'NY',
    bounds: [40.47, -74.27, 40.93, -73.68],
    resourceUrl: 'https://data.cityofnewyork.us/resource/uf93-f8nk.json',
    locationField: 'the_geom',
    numberField: 'house_number',
    skipIfSetFields: ['house_number_suffix'],
    streetFields: ['pre_modifier', 'pre_directional', 'street_name', 'post_type', 'post_directional', 'post_modifier'],
    ordinalizeNumericField: 'street_name',
    zipField: 'zipcode',
    geoJsonField: 'the_geom',
    source: 'NYC Department of City Planning, Address Points (data.cityofnewyork.us)',
  },
  // Orange County, FL (Orlando and the county): 714,909 points, active only.
  {
    kind: 'layer',
    id: 'orange-fl',
    state: 'FL',
    bounds: [28.34, -81.66, 28.79, -81.05],
    queryUrl: 'https://ocgis4.ocfl.net/arcgis/rest/services/AGOL_Open_Data/MapServer/0/query',
    numberField: 'ADDRESS_NUMBER',
    skipIfSetFields: ['ADDRESS_NUMBER_SUFFIX'],
    streetFields: ['PRE_MODIFIER', 'PRE_DIRECTION', 'PRE_TYPE', 'BASENAME', 'POST_TYPE', 'POST_DIRECTION', 'POST_MODIFIER'],
    unitField: 'UNIT',
    cityField: 'MUNICIPAL_JURISDICTION',
    zipField: 'ZIPCODE',
    where: "ADDRESS_STATUS = 'Active'",
    source: 'Orange County, FL GIS, Address Points (ocgis4.ocfl.net)',
  },
  // Los Angeles County's Countywide Address Management System (CAMS): about 2.7
  // million primary addresses contributed by the county and its cities. Where a
  // city did not map every address the Assessor's primary address is the only
  // one shown, so a missing number here is not evidence of anything.
  {
    kind: 'layer',
    id: 'lacounty-ca',
    state: 'CA',
    bounds: [33.65, -118.95, 34.85, -117.6],
    queryUrl: 'https://services.arcgis.com/RmCCgQtiZLDCtblq/ArcGIS/rest/services/eGIS_Addressing_ADDRESS_POINTSv2/FeatureServer/0/query',
    numberField: 'Number',
    skipIfSetFields: ['NumPrefix', 'NumSuffix'],
    streetFields: ['PreMod', 'PreDir', 'PreType', 'StreetName', 'PostType', 'PostDir', 'PostMod'],
    unitField: 'UnitName',
    cityField: 'PostComm1',
    zipField: 'ZipCode',
    source: 'Los Angeles County eGIS, CAMS Address Points (services.arcgis.com)',
  },
  // City of Chicago's address-point locator (point addresses only; Chicago
  // publishes no queryable address-point table). Spelling differs from the
  // postal form ("LASALLE" for "La Salle"), so the score floor is 90, not 97.
  {
    kind: 'geocoder',
    id: 'chicago-il',
    state: 'IL',
    bounds: [41.64, -87.95, 42.03, -87.5],
    findUrl: 'https://gisapps.chicago.gov/arcgis/rest/services/AddressPoints/GeocodeServer/findAddressCandidates',
    minScore: 90,
    source: 'City of Chicago, Address Points locator (gisapps.chicago.gov)',
  },
  // West Virginia's statewide Site Address Points (SAMS-II, WVU GIS Technical
  // Center) are only published through this locator. Point addresses only.
  {
    kind: 'geocoder',
    id: 'wv-site',
    state: 'WV',
    bounds: [37.15, -82.7, 40.7, -77.7],
    findUrl: 'https://services.wvgis.wvu.edu/arcgis/rest/services/Geocode/WV_Site/GeocodeServer/findAddressCandidates',
    minScore: 97,
    source: 'WV GIS Technical Center, statewide Site Address Points (services.wvgis.wvu.edu)',
  },
];

/** A cached empty result is not worth keeping; this only guards against hammering a service for the same box within one run. */
const NO_POINTS: AddressPoint[] = [];

function inBounds(src: SourceBase, lat: number, lon: number): boolean {
  return lat >= src.bounds[0] && lat <= src.bounds[2] && lon >= src.bounds[1] && lon <= src.bounds[3];
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim());

async function getJson(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

interface RawLayerFeature {
  attributes?: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

/** "2" -> "2nd", "11" -> "11th", "23" -> "23rd". Anything that is not a plain number is returned unchanged. */
export function ordinal(value: string): string {
  if (!/^\d+$/.test(value)) return value;
  const n = Number(value);
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  return `${value}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

export function layerFeatureToPoint(src: LayerPointSource, f: RawLayerFeature): AddressPoint | null {
  const a = f.attributes;
  const g = f.geometry;
  if (!a || !g || typeof g.x !== 'number' || typeof g.y !== 'number') return null;
  if (!Number.isFinite(g.x) || !Number.isFinite(g.y)) return null;
  for (const field of src.skipIfSetFields ?? []) if (str(a[field]) !== '') return null;
  const houseNumber = str(a[src.numberField]);
  if (!/^\d+$/.test(houseNumber) || houseNumber === '0') return null;
  const street = src.streetFields
    .map((field) => (field === src.ordinalizeNumericField ? ordinal(str(a[field])) : str(a[field])))
    .filter((p) => p !== '')
    .join(' ');
  if (street === '') return null;
  return {
    houseNumber,
    street,
    unit: src.unitField ? str(a[src.unitField]) || null : null,
    city: src.cityField ? str(a[src.cityField]) || null : null,
    zip: src.zipField ? str(a[src.zipField]).slice(0, 5) || null : null,
    placement: null,
    source: src.source,
    lat: g.y,
    lon: g.x,
  };
}

const DIRECTION_WORDS = new Set(['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest']);

/**
 * Hennepin County writes Minneapolis's downtown streets "5th Street South"
 * while Census and the USPS write "S 5th St": the same street, with the
 * directional moved. The matcher compares directional position literally, so
 * when a point's street and the target's are the same words in a different
 * order, and the only word that moved is a directional, the point is given the
 * target's own spelling. Anything else (different words, a different
 * directional) is left exactly as published.
 */
export function reconcileDirectionalPosition(pointStreet: string, targetStreet: string): string {
  const a = streetKey(pointStreet).split(' ');
  const b = streetKey(targetStreet).split(' ');
  if (a.join(' ') === b.join(' ') || a.length !== b.length || a.length < 2) return pointStreet;
  if ([...a].sort().join(' ') !== [...b].sort().join(' ')) return pointStreet;
  const movedLeadToTail = DIRECTION_WORDS.has(a[0]) && DIRECTION_WORDS.has(b[b.length - 1]) && a.slice(1).join(' ') === b.slice(0, -1).join(' ');
  const movedTailToLead = DIRECTION_WORDS.has(a[a.length - 1]) && DIRECTION_WORDS.has(b[0]) && a.slice(0, -1).join(' ') === b.slice(1).join(' ');
  return movedLeadToTail || movedTailToLead ? targetStreet : pointStreet;
}

async function queryLayer(
  src: LayerPointSource,
  lat: number,
  lon: number,
  radiusMeters: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ points: AddressPoint[]; exceeded: boolean }> {
  const dLat = radiusMeters / 111_320;
  const dLon = radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180));
  const outFields = [
    src.numberField,
    ...(src.skipIfSetFields ?? []),
    ...src.streetFields,
    ...[src.unitField, src.cityField, src.zipField].filter((f): f is string => !!f),
  ].join(',');
  const params = new URLSearchParams({
    geometry: `${lon - dLon},${lat - dLat},${lon + dLon},${lat + dLat}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    where: src.where ?? '1=1',
    outFields,
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json',
  });
  const body = (await getJson(`${src.queryUrl}?${params.toString()}`, fetchImpl, timeoutMs)) as {
    error?: unknown;
    features?: RawLayerFeature[];
    exceededTransferLimit?: boolean;
  };
  if (body.error) throw new Error(JSON.stringify(body.error));
  const points = (body.features ?? []).map((f) => layerFeatureToPoint(src, f)).filter((p): p is AddressPoint => p !== null);
  return { points, exceeded: body.exceededTransferLimit === true };
}

export function socrataRowToPoint(src: SocrataPointSource, row: Record<string, unknown>): AddressPoint | null {
  for (const field of src.skipIfSetFields ?? []) if (str(row[field]) !== '') return null;
  const houseNumber = str(row[src.numberField]);
  if (!/^\d+$/.test(houseNumber) || houseNumber === '0') return null;
  const street = src.streetFields
    .map((field) => (field === src.ordinalizeNumericField ? ordinal(str(row[field])) : str(row[field])))
    .filter((p) => p !== '')
    .join(' ');
  let lat = NaN;
  let lon = NaN;
  if (src.geoJsonField) {
    const coords = (row[src.geoJsonField] as { coordinates?: unknown[] } | undefined)?.coordinates;
    if (Array.isArray(coords)) {
      lon = Number(coords[0]);
      lat = Number(coords[1]);
    }
  } else if (src.latField && src.lonField) {
    lat = Number(str(row[src.latField]));
    lon = Number(str(row[src.lonField]));
  }
  if (street === '' || !Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0 || lon === 0) return null;
  return {
    houseNumber,
    street,
    unit: src.unitField ? str(row[src.unitField]) || null : null,
    city: null,
    zip: src.zipField ? str(row[src.zipField]).slice(0, 5) || null : null,
    placement: null,
    source: src.source,
    lat,
    lon,
  };
}

/** Rows near a point from a Socrata table. 5,000 rows is far more than any one city block holds. */
async function querySocrata(src: SocrataPointSource, lat: number, lon: number, radiusMeters: number, fetchImpl: typeof fetch, timeoutMs: number): Promise<AddressPoint[]> {
  const select = [
    src.numberField,
    ...(src.skipIfSetFields ?? []),
    ...src.streetFields,
    ...[src.unitField, src.zipField, src.latField, src.lonField, src.geoJsonField].filter((f): f is string => !!f),
  ].join(',');
  const params = new URLSearchParams({
    $select: select,
    $where: `within_circle(${src.locationField}, ${lat}, ${lon}, ${radiusMeters})`,
    $limit: '5000',
  });
  const body = await getJson(`${src.resourceUrl}?${params.toString()}`, fetchImpl, timeoutMs);
  if (!Array.isArray(body)) throw new Error('unexpected Socrata response');
  return (body as Record<string, unknown>[]).map((row) => socrataRowToPoint(src, row)).filter((p): p is AddressPoint => p !== null);
}

/**
 * Whether a locator candidate's street is the street that was asked for.
 *
 * The name must match; the directionals must be the SAME set (a locator
 * returns "E KANAWHA BLVD E" for "Kanawha Blvd E": one direction written
 * twice, which is one direction); and the street type may differ only by being
 * absent on one side. Comparing the name alone, as this once did, accepted a
 * candidate on the opposite side of a divided street ("S Main St" for "N Main
 * St") or a different street ("Main Ave" for "Main St"), and the caller then
 * stamped the target's spelling on it so nothing downstream could object.
 */
export function sameLocatorStreet(candidate: string, target: string): boolean {
  if (coreStreet(candidate) !== coreStreet(target)) return false;
  if (streetDirectionals(candidate).join() !== streetDirectionals(target).join()) return false;
  if (hasStreetType(candidate) && hasStreetType(target)) {
    return streetKeyWithoutDirectionals(candidate) === streetKeyWithoutDirectionals(target);
  }
  return true;
}

/** Street name stripped of directionals and a trailing street-type word, so "KANAWHA BLVD E" and "Kanawha Blvd" compare. */
function coreStreet(street: string): string {
  const tokens = streetKeyWithoutDirectionals(street).split(' ');
  if (tokens.length > 1 && new Set(Object.values(STREET_TYPES)).has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

interface GeocoderCandidate {
  location?: { x?: number; y?: number };
  score?: number;
  attributes?: Record<string, unknown>;
}

/** One government geocoder, asked for the exact address. A candidate counts only when it is a point address (not a street interpolation), scores at least minScore, and agrees with the target on house number and core street name. */
async function queryGeocoder(
  src: GeocoderPointSource,
  oneLineAddress: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<AddressPoint[]> {
  const parts = parseAddressParts(oneLineAddress);
  if (!parts.houseNumber || !parts.street) return NO_POINTS;
  const params = new URLSearchParams({
    SingleLine: oneLineAddress,
    outSR: '4326',
    outFields: '*',
    maxLocations: '3',
    f: 'json',
  });
  const body = (await getJson(`${src.findUrl}?${params.toString()}`, fetchImpl, timeoutMs)) as {
    error?: unknown;
    candidates?: GeocoderCandidate[];
  };
  if (body.error) throw new Error(JSON.stringify(body.error));
  const out: AddressPoint[] = [];
  for (const c of body.candidates ?? []) {
    const a = c.attributes ?? {};
    const loc = c.location;
    if (!loc || typeof loc.x !== 'number' || typeof loc.y !== 'number') continue;
    if (str(a.Addr_type) !== 'PointAddress') continue;
    if ((c.score ?? 0) < src.minScore) continue;
    if (str(a.AddNum) !== parts.houseNumber) continue;
    const candidateStreet = [a.StPreDir, a.StPreType, a.StName, a.StType, a.StDir].map(str).filter(Boolean).join(' ');
    if (!sameLocatorStreet(candidateStreet, parts.street)) continue;
    out.push({
      houseNumber: parts.houseNumber,
      // The candidate was just checked against the target on name, directional and type (sameLocatorStreet), so it carries the target's spelling; this keeps matchAddressPoint's directional guards from tripping on the service's own "E KANAWHA BLVD E" duplication.
      street: parts.street,
      unit: null,
      city: str(a.City) || null,
      zip: str(a.Postal) || null,
      placement: null,
      source: src.source,
      lat: loc.y,
      lon: loc.x,
    });
  }
  return out;
}

/** After this many metres a dense box is retried tighter when the service says it truncated the answer. */
const DENSE_RETRY_METERS = 100;

/**
 * Every registered government address point near a coordinate, from the
 * sources whose bounds contain it. Never throws: a failing source
 * contributes nothing, which the caller already treats as "this source had
 * nothing to add".
 */
export async function fetchCountyAddressPoints(
  oneLineAddress: string,
  lat: number,
  lon: number,
  radiusMeters: number,
  fetchImpl: typeof fetch = fetch,
  { timeoutMs = 20_000 }: FetchOptions = {},
): Promise<AddressPoint[]> {
  const parts = parseAddressParts(oneLineAddress);
  if (!parts.state) return NO_POINTS;
  const state = parts.state.toUpperCase();
  const sources = ADDRESS_POINT_SOURCES.filter((s) => s.state === state && inBounds(s, lat, lon));
  if (sources.length === 0) return NO_POINTS;

  const results = await Promise.all(
    sources.map(async (src): Promise<AddressPoint[]> => {
      try {
        if (src.kind === 'geocoder') return await queryGeocoder(src, oneLineAddress, fetchImpl, timeoutMs);
        if (src.kind === 'socrata') return await querySocrata(src, lat, lon, radiusMeters, fetchImpl, timeoutMs);
        let r = await queryLayer(src, lat, lon, radiusMeters, fetchImpl, timeoutMs);
        if (r.exceeded && radiusMeters > DENSE_RETRY_METERS) {
          r = await queryLayer(src, lat, lon, DENSE_RETRY_METERS, fetchImpl, timeoutMs);
        }
        const target = parts.street;
        return target ? r.points.map((p) => (p.street ? { ...p, street: reconcileDirectionalPosition(p.street, target) } : p)) : r.points;
      } catch {
        return NO_POINTS;
      }
    }),
  );
  return results.flat();
}
